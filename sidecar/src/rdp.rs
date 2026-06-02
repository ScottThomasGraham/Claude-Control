// sidecar/src/rdp.rs
//
// Live RDP session module (Phase 2). Built directly against the real IronRDP
// API as shipped in:
//   ironrdp 0.15.0, ironrdp-connector/-session/-async/-tokio 0.9.0,
//   ironrdp-graphics/-pdu 0.8.0, ironrdp-input 0.6.0.
//
// The connect sequence mirrors ironrdp's own `screenshot` example
// (examples/screenshot.rs in the ironrdp 0.15 crate) but uses the async
// tokio path instead of the blocking one, and keeps the session open in a
// background task that continuously pumps graphics updates into the shared
// framebuffer and drains queued input events.
//
// Public seam consumed by main.rs (kept stable across phases):
//   ConnectParams / SessionHandle / connect / SessionHandle::{pointer,key,shutdown}
//
// TODO(task11): the full path below compiles cleanly but has NOT been run
// against a live RDP server (none was available in Task 10). Verify against a
// real Windows host:
//   - CredSSP/NLA handshake succeeds with the supplied username/password.
//   - GraphicsUpdates actually repaint the shared framebuffer (frame PNGs show
//     the live desktop, not the blank fallback).
//   - pointer + scancode/unicode input land on the remote desktop.
//   - consider auto-reconnect with backoff in session_task on read errors
//     (currently the task exits and marks disconnected; main re-connects on the
//     next `connect` call).

use std::sync::Arc;

use anyhow::{Context as _, Result};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinHandle;

use ironrdp::core::WriteBuf;
use ironrdp_async::Framed;
use ironrdp_connector::connection_activation::ConnectionActivationState;
use ironrdp_connector::{
    ClientConnector, Config as ConnectorConfig, Credentials, DesktopSize, Sequence as _,
};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp_pdu::gcc::KeyboardType;
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_session::fast_path::ProcessorBuilder as FastPathProcessorBuilder;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageOutput};
use ironrdp_tokio::{reqwest::ReqwestNetworkClient, single_sequence_step, TokioStream};
use tokio_rustls::rustls;

use crate::Shared;

pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub width: u32,
    pub height: u32,
}

/// A high-level input request, queued from the IPC thread and applied by the
/// background session task (which owns the IronRDP input Database + write half).
enum InputOp {
    Pointer { x: i32, y: i32, action: String, button: String, wheel: i32 },
    Key { scancode: Option<u32>, unicode: Option<u32>, down: bool },
}

/// Owns the channel to the live session task + the task's join handle.
pub struct SessionHandle {
    tx: UnboundedSender<InputOp>,
    task: JoinHandle<()>,
}

impl SessionHandle {
    pub fn pointer(&self, x: i32, y: i32, action: &str, button: &str, wheel: i32) {
        let _ = self.tx.send(InputOp::Pointer {
            x,
            y,
            action: action.to_string(),
            button: button.to_string(),
            wheel,
        });
    }

    pub fn key(&self, scancode: Option<u32>, unicode: Option<u32>, down: bool) {
        let _ = self.tx.send(InputOp::Key { scancode, unicode, down });
    }

    pub fn shutdown(self) {
        // Dropping the sender ends the input stream; abort the task to close the
        // TCP/TLS stream promptly.
        self.task.abort();
    }
}

// The TLS-wrapped TCP stream used for the active RDP session.
type RdpTlsStream = tokio_rustls::client::TlsStream<TcpStream>;
type RdpFramed = Framed<TokioStream<RdpTlsStream>>;

/// Bring up a live RDP session and spawn the background pump task.
pub async fn connect(state: Shared, params: ConnectParams) -> Result<SessionHandle> {
    // Install a process-wide rustls crypto provider (idempotent / best-effort).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let server_name = params.host.clone();
    let connector_config = build_config(&params)?;

    // --- TCP connect ------------------------------------------------------
    let addr = format!("{}:{}", params.host, params.port);
    let tcp = TcpStream::connect(&addr)
        .await
        .with_context(|| format!("TCP connect to {addr}"))?;
    let client_addr = tcp.local_addr().context("local_addr")?;

    // --- RDP connection: begin (pre-TLS) ----------------------------------
    let mut framed: Framed<TokioStream<TcpStream>> = ironrdp_tokio::TokioFramed::new(tcp);
    let mut connector = ClientConnector::new(connector_config, client_addr);

    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|e| anyhow::anyhow!("connect_begin: {e}"))?;

    // --- TLS upgrade ------------------------------------------------------
    let initial_stream = framed.into_inner_no_leftover();
    let (upgraded_stream, server_public_key) =
        tls_upgrade(initial_stream, server_name.clone())
            .await
            .context("TLS upgrade")?;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut upgraded_framed: RdpFramed = ironrdp_tokio::TokioFramed::new(upgraded_stream);

    // --- RDP connection: finalize (CredSSP + capability exchange) ---------
    let mut network_client = ReqwestNetworkClient::new();
    let connection_result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut network_client,
        server_name.into(),
        server_public_key,
        None,
    )
    .await
    .map_err(|e| anyhow::anyhow!("connect_finalize: {e}"))?;

    let desktop = connection_result.desktop_size;
    eprintln!(
        "[cc-rdp] RDP connected, negotiated desktop {}x{}",
        desktop.width, desktop.height
    );

    // Seed the shared framebuffer to the negotiated size immediately so `frame`
    // and `status` report correct dimensions even before the first paint.
    {
        let mut st = state.lock().await;
        st.fb = crate::Framebuffer::blank(u32::from(desktop.width), u32::from(desktop.height));
    }

    // --- Spawn the background session task --------------------------------
    let (tx, rx) = mpsc::unbounded_channel::<InputOp>();
    let image = DecodedImage::new(PixelFormat::RgbA32, desktop.width, desktop.height);
    let active_stage = ActiveStage::new(connection_result);

    let task = tokio::spawn(session_task(state, upgraded_framed, active_stage, image, rx));

    Ok(SessionHandle { tx, task })
}

/// The long-lived session pump: read server PDUs → decode graphics into the
/// shared framebuffer; drain queued input → encode + send to the server.
async fn session_task(
    state: Shared,
    mut framed: RdpFramed,
    mut active_stage: ActiveStage,
    mut image: DecodedImage,
    mut input_rx: mpsc::UnboundedReceiver<InputOp>,
) {
    let mut db = Database::new();

    // Opt-in stderr tracing (NEVER stdout — stdout is the IPC channel; we never
    // log the password). Checked once at task entry. Enable with CC_RDP_DEBUG=1.
    let debug = std::env::var("CC_RDP_DEBUG").is_ok();
    if debug {
        eprintln!("[cc-rdp][dbg] session_task started");
    }

    loop {
        tokio::select! {
            // Server → client: graphics / control PDUs.
            read = framed.read_pdu() => {
                let (action, payload) = match read {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[cc-rdp] read_pdu error: {e}; session ending");
                        break;
                    }
                };
                if debug {
                    eprintln!("[cc-rdp][dbg] read_pdu action={action:?} len={}", payload.len());
                }

                let outputs = match active_stage.process(&mut image, action, &payload) {
                    Ok(o) => o,
                    Err(e) => {
                        eprintln!("[cc-rdp] active_stage.process error: {e}; session ending");
                        break;
                    }
                };

                let mut graphics_changed = false;
                for out in outputs {
                    if debug {
                        eprintln!("[cc-rdp][dbg] output={}", active_stage_output_name(&out));
                    }
                    match out {
                        ActiveStageOutput::ResponseFrame(frame) => {
                            if let Err(e) = write_all(&mut framed, &frame).await {
                                eprintln!("[cc-rdp] write response error: {e}; session ending");
                                return mark_disconnected(&state).await;
                            }
                        }
                        ActiveStageOutput::GraphicsUpdate(_region) => {
                            graphics_changed = true;
                        }
                        ActiveStageOutput::Terminate(reason) => {
                            eprintln!("[cc-rdp] server terminated session: {reason}");
                            return mark_disconnected(&state).await;
                        }
                        // Windows servers send ServerDeactivateAll during session
                        // bring-up (MS-RDPBCGR §1.3.1.3 Deactivation-Reactivation).
                        // IronRDP hands us a fresh ConnectionActivationSequence that
                        // we MUST drive to Finalized (re-running capabilities exchange
                        // + connection finalization) before the server will send any
                        // graphics. Dropping this is the original "blank framebuffer
                        // forever" bug. We keep the SAME ActiveStage (matching the
                        // upstream ironrdp-client) and only rebuild its fast-path
                        // processor + share/pointer state from the finalized values.
                        ActiveStageOutput::DeactivateAll(mut cas) => {
                            if debug {
                                eprintln!("[cc-rdp][dbg] DeactivateAll: driving reactivation");
                            }
                            // Drive the carried sequence to Finalized against the SAME
                            // framed stream (single_sequence_step does read+write).
                            let mut buf = WriteBuf::new();
                            let finalized = loop {
                                if debug {
                                    eprintln!(
                                        "[cc-rdp][dbg] reactivation step state={}",
                                        cas.state().name()
                                    );
                                }
                                if let Err(e) =
                                    single_sequence_step(&mut framed, &mut *cas, &mut buf).await
                                {
                                    eprintln!(
                                        "[cc-rdp] reactivation sequence step error: {e}; session ending"
                                    );
                                    return mark_disconnected(&state).await;
                                }
                                if let ConnectionActivationState::Finalized {
                                    io_channel_id,
                                    user_channel_id,
                                    desktop_size,
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                } = cas.connection_activation_state()
                                {
                                    break (
                                        io_channel_id,
                                        user_channel_id,
                                        desktop_size,
                                        share_id,
                                        enable_server_pointer,
                                        pointer_software_rendering,
                                    );
                                }
                            };
                            let (
                                io_channel_id,
                                user_channel_id,
                                desktop_size,
                                share_id,
                                enable_server_pointer,
                                pointer_software_rendering,
                            ) = finalized;

                            // Rebuild the fast-path processor + share/pointer state on
                            // the existing ActiveStage so processing resumes in the
                            // reactivated session. (Mirrors ironrdp-client's
                            // set_fastpath_processor / set_share_id / set_enable_server_pointer.)
                            // NOTE: bulk_decompressor is None here because compression
                            // is not negotiated in this client (compression_type=None);
                            // matches upstream which also passes None in this path.
                            active_stage.set_fastpath_processor(
                                FastPathProcessorBuilder {
                                    io_channel_id,
                                    user_channel_id,
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: None,
                                }
                                .build(),
                            );
                            active_stage.set_share_id(share_id);
                            active_stage.set_enable_server_pointer(enable_server_pointer);

                            // Resize the decoded image + shared framebuffer to the
                            // newly negotiated desktop size.
                            image = DecodedImage::new(
                                PixelFormat::RgbA32,
                                desktop_size.width,
                                desktop_size.height,
                            );
                            {
                                let mut st = state.lock().await;
                                st.fb = crate::Framebuffer::blank(
                                    u32::from(desktop_size.width),
                                    u32::from(desktop_size.height),
                                );
                            }
                            if debug {
                                eprintln!(
                                    "[cc-rdp][dbg] reactivation finalized {}x{}",
                                    desktop_size.width, desktop_size.height
                                );
                            }
                            // LIVE-RUN MUST CONFIRM: after this point the server begins
                            // sending FastPath/X224 graphics and the framebuffer repaints
                            // (status.last_update advances). Continue the loop — do NOT break.
                        }
                        _ => {}
                    }
                }

                if graphics_changed {
                    if debug {
                        eprintln!(
                            "[cc-rdp][dbg] copy_image_to_framebuffer {}x{}",
                            image.width(),
                            image.height()
                        );
                    }
                    copy_image_to_framebuffer(&state, &image).await;
                }
            }

            // Client → server: queued input events.
            maybe_op = input_rx.recv() => {
                let Some(op) = maybe_op else {
                    // Sender dropped (shutdown): end the session.
                    break;
                };

                let ops = translate_input(op, &image);
                if ops.is_empty() {
                    continue;
                }
                let events = db.apply(ops);
                if events.is_empty() {
                    continue;
                }
                match active_stage.process_fastpath_input(&mut image, &events) {
                    Ok(outputs) => {
                        for out in outputs {
                            if let ActiveStageOutput::ResponseFrame(frame) = out {
                                if let Err(e) = write_all(&mut framed, &frame).await {
                                    eprintln!("[cc-rdp] write input error: {e}; session ending");
                                    return mark_disconnected(&state).await;
                                }
                            }
                        }
                    }
                    Err(e) => eprintln!("[cc-rdp] process_fastpath_input error: {e}"),
                }
            }
        }
    }

    mark_disconnected(&state).await;
}

/// Short variant name for an `ActiveStageOutput`, for CC_RDP_DEBUG tracing.
///
/// NOTE: ironrdp-session 0.9.0 does NOT expose `ActiveStageOutput::description()`
/// (that method lives on `GracefulDisconnectReason`), so we name variants here.
fn active_stage_output_name(out: &ActiveStageOutput) -> &'static str {
    match out {
        ActiveStageOutput::ResponseFrame(_) => "ResponseFrame",
        ActiveStageOutput::GraphicsUpdate(_) => "GraphicsUpdate",
        ActiveStageOutput::PointerDefault => "PointerDefault",
        ActiveStageOutput::PointerHidden => "PointerHidden",
        ActiveStageOutput::PointerPosition { .. } => "PointerPosition",
        ActiveStageOutput::PointerBitmap(_) => "PointerBitmap",
        ActiveStageOutput::Terminate(_) => "Terminate",
        ActiveStageOutput::DeactivateAll(_) => "DeactivateAll",
        ActiveStageOutput::MultitransportRequest(_) => "MultitransportRequest",
        ActiveStageOutput::AutoDetect(_) => "AutoDetect",
    }
}

async fn mark_disconnected(state: &Shared) {
    let mut st = state.lock().await;
    st.connected = false;
    st.session = None; // best-effort; main may already have taken it
}

async fn write_all(framed: &mut RdpFramed, buf: &[u8]) -> Result<()> {
    use ironrdp_async::FramedWrite as _;
    framed
        .write_all(buf)
        .await
        .map_err(|e| anyhow::anyhow!("framed write: {e}"))
}

/// Copy the decoded RGBA image into the shared framebuffer and bump its age.
async fn copy_image_to_framebuffer(state: &Shared, image: &DecodedImage) {
    let w = u32::from(image.width());
    let h = u32::from(image.height());
    let data = image.data();

    let mut st = state.lock().await;
    if st.fb.width != w || st.fb.height != h || st.fb.rgba.len() != data.len() {
        st.fb.width = w;
        st.fb.height = h;
        st.fb.rgba = data.to_vec();
    } else {
        st.fb.rgba.copy_from_slice(data);
    }
    st.fb.last_update = std::time::Instant::now();
}

/// Translate one IPC input op into IronRDP `Operation`s.
fn translate_input(op: InputOp, image: &DecodedImage) -> Vec<Operation> {
    match op {
        InputOp::Pointer { x, y, action, button, wheel } => {
            let pos = clamp_pos(x, y, image);
            let btn = parse_button(&button);
            match action.as_str() {
                "move" => vec![Operation::MouseMove(pos)],
                "down" => vec![Operation::MouseMove(pos), Operation::MouseButtonPressed(btn)],
                "up" => vec![Operation::MouseMove(pos), Operation::MouseButtonReleased(btn)],
                "click" => vec![
                    Operation::MouseMove(pos),
                    Operation::MouseButtonPressed(btn),
                    Operation::MouseButtonReleased(btn),
                ],
                "double" => vec![
                    Operation::MouseMove(pos),
                    Operation::MouseButtonPressed(btn),
                    Operation::MouseButtonReleased(btn),
                    Operation::MouseButtonPressed(btn),
                    Operation::MouseButtonReleased(btn),
                ],
                "wheel" => {
                    // One wheel "click" is 120 rotation units in RDP.
                    let units = (wheel.clamp(-273, 273) * 120) as i16;
                    vec![Operation::WheelRotations(WheelRotations {
                        is_vertical: true,
                        rotation_units: units,
                    })]
                }
                _ => Vec::new(),
            }
        }
        InputOp::Key { scancode, unicode, down } => {
            if let Some(sc) = scancode {
                // Node sends extended keys with 0xE0 in the HIGH byte (e.g.
                // 0xE048). Scancode::from_u16 detects extended via `& 0xE000`,
                // so this maps directly.
                let code = Scancode::from_u16((sc & 0xFFFF) as u16);
                if down {
                    vec![Operation::KeyPressed(code)]
                } else {
                    vec![Operation::KeyReleased(code)]
                }
            } else if let Some(cp) = unicode {
                match char::from_u32(cp) {
                    Some(ch) if down => vec![Operation::UnicodeKeyPressed(ch)],
                    Some(ch) => vec![Operation::UnicodeKeyReleased(ch)],
                    None => Vec::new(),
                }
            } else {
                Vec::new()
            }
        }
    }
}

fn clamp_pos(x: i32, y: i32, image: &DecodedImage) -> MousePosition {
    let max_x = image.width().saturating_sub(1);
    let max_y = image.height().saturating_sub(1);
    let cx = x.clamp(0, i32::from(max_x)) as u16;
    let cy = y.clamp(0, i32::from(max_y)) as u16;
    MousePosition { x: cx, y: cy }
}

fn parse_button(b: &str) -> MouseButton {
    match b {
        "right" => MouseButton::Right,
        "middle" => MouseButton::Middle,
        _ => MouseButton::Left,
    }
}

fn build_config(params: &ConnectParams) -> Result<ConnectorConfig> {
    Ok(ConnectorConfig {
        credentials: Credentials::UsernamePassword {
            username: params.username.clone(),
            password: params.password.clone(),
        },
        domain: None,
        // TLS is performed by us (tls_upgrade); CredSSP runs on top.
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: params.width.clamp(1, 8192) as u16,
            height: params.height.clamp(1, 8192) as u16,
        },
        bitmap: None,
        client_build: 0,
        client_name: "claude-control".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),

        #[cfg(windows)]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(target_os = "macos")]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(target_os = "linux")]
        platform: MajorPlatformType::UNIX,
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        platform: MajorPlatformType::UNSPECIFIED,

        // No interactive user / custom pointer; we rasterize the framebuffer.
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: None,
        pointer_software_rendering: true,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    })
}

/// Perform the TLS handshake over the established TCP stream and extract the
/// server's TLS public key (needed for CredSSP channel binding).
async fn tls_upgrade(
    stream: TcpStream,
    server_name: String,
) -> Result<(RdpTlsStream, Vec<u8>)> {
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(danger::NoCertificateVerification))
        .with_no_client_auth();

    // CredSSP does not support TLS session resumption.
    config.resumption = rustls::client::Resumption::disabled();

    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));

    let dns_name = rustls::pki_types::ServerName::try_from(server_name)
        .context("invalid server name for TLS")?
        .to_owned();

    let tls_stream = connector
        .connect(dns_name, stream)
        .await
        .context("TLS handshake")?;

    // Extract the peer certificate's subject public key.
    let server_public_key = {
        let (_, conn) = tls_stream.get_ref();
        let cert = conn
            .peer_certificates()
            .and_then(|certs| certs.first())
            .context("peer certificate missing")?;
        extract_tls_server_public_key(cert)?
    };

    Ok((tls_stream, server_public_key))
}

fn extract_tls_server_public_key(cert: &[u8]) -> Result<Vec<u8>> {
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(cert).context("parse server cert")?;
    let key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .context("subject public key BIT STRING not aligned")?
        .to_owned();
    Ok(key)
}

mod danger {
    use tokio_rustls::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use tokio_rustls::rustls::{pki_types, DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    pub(super) struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _: &pki_types::CertificateDer<'_>,
            _: &[pki_types::CertificateDer<'_>],
            _: &pki_types::ServerName<'_>,
            _: &[u8],
            _: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA1,
                SignatureScheme::ECDSA_SHA1_Legacy,
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
                SignatureScheme::ED448,
            ]
        }
    }
}
