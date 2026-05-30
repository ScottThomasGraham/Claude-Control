# Research: distribution, packaging, CI, repo structure, licensing

*Captured 2026-05-30. Sourced web research synthesized into a brief.*

## 1. Rust release/distribution tooling
**cargo-dist (now `dist`, axo.dev)** is the strongest turnkey option. One `dist init` generates:
shell + PowerShell **installers**, a **Homebrew tap** formula, **MSI** (via WiX), tarballs, checksums,
debug symbols, and **a GitHub Actions release workflow** that fires on a `vX.Y.Z` tag and publishes a
GitHub Release with all artifacts ([dist book](https://axodotdev.github.io/cargo-dist/book/introduction.html)).
It cross-compiles via cargo-zigbuild / cargo-xwin and builds **macOS universal binaries**. Note:
axo.dev wound down commercial operations in 2025 — treat `dist` as mature-but-community-maintained.
Complementary: **cargo-binstall** (`[package.metadata.binstall]` lets users
`cargo binstall yourtool`). Fallback: a plain **GitHub Actions matrix** +
`softprops/action-gh-release`.

## 2. macOS distribution
Build **universal2** (`aarch64` + `x86_64` merged with `lipo`; dist does this). Distribution outside
the App Store needs a **paid Apple Developer account ($99/yr)** + a **Developer ID Application**
certificate. Sign with hardened runtime (`codesign --options runtime`), **notarize with
`notarytool submit --wait`**, then staple. Gotcha: **you cannot staple a bare Mach-O** — staple
`.dmg`/`.pkg`/`.app`; for a CLI, zip → notarize, or distribute a `.pkg`. **A `brew install` from your
own tap avoids the quarantine bit** (Homebrew fetches without it) — so a Homebrew tap is the path of
least resistance for a developer CLI, even unsigned; signing+notarization remains the professional
standard. ([Apple Developer ID](https://developer.apple.com/developer-id/))

## 3. Windows agent distribution
Sign the `.exe` with **Authenticode**. 2024+ change: **EV certs no longer grant instant SmartScreen
reputation** — EV and OV build reputation identically, so the EV premium isn't justified for
SmartScreen alone ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
Consider **Microsoft Trusted/Artifact Signing** (cloud, CI-friendly, no hardware token). **For an
agent auto-pushed over SSH, SmartScreen is irrelevant** (it gates interactive downloads). Ship a
**bare signed exe**, not an MSI — still sign it (tamper-evidence, AV/EDR, post-transfer integrity).

## 4. CI (GitHub Actions)
Two-stage. **Lint/test** (on PRs): matrix `macos-14` (arm64) + `windows-latest` running
`cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`. **Release** (on `v*` tag): matrix
`{ macos → universal-apple-darwin (lipo), windows → x86_64-pc-windows-msvc }`; upload per-target
artifacts; dependent `release` job runs `softprops/action-gh-release`. Adopting `dist` emits this
workflow (incl. signing/notarization wired to repo secrets).

## 5. Repo structure
Cargo **workspace**:
```
Cargo.toml            # [workspace] members + default-members
crates/
  protocol/           # shared types (builds everywhere)
  controller/         # macOS/Linux binary
  agent/              # windows-agent .exe
docs/  (specs/, plans/, research/, architecture/)
README.md LICENSE-MIT LICENSE-APACHE CONTRIBUTING.md CHANGELOG.md
```
Keep the workspace **building on every OS**. Don't `#![cfg(target_os="windows")]` a whole `main.rs`
(empties the crate → "no main"). Instead scope Windows deps with
`[target.'cfg(windows)'.dependencies]` and put platform code behind `#[cfg(windows)]` modules so the
crate still compiles to a stub on macOS. Use `default-members` so a bare `cargo build` on a Mac skips
the agent. ([Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html))

## 6. Licensing
IronRDP is **`MIT OR Apache-2.0`** ([crates.io](https://crates.io/crates/ironrdp)) — the ecosystem
standard. As a consumer: **retain copyright/license notices** and preserve any **NOTICE** file
(Apache §4). Adopt **`MIT OR Apache-2.0`** for this project (max compatibility, Apache patent grant,
MIT GPLv2 interop); ship `LICENSE-APACHE` + `LICENSE-MIT`. Enforce with `cargo deny check licenses`
in CI to catch transitive copyleft.

## Bottom line
Adopt **`dist`** as the release engine: one tagged push → a GitHub Release with a **universal2 macOS
binary** + **Homebrew tap** (primary macOS install) and a **signed Windows exe**. Get the **$99 Apple
Developer account**, sign with **Developer ID** + notarize macOS; sign the Windows agent with an
**OV/Trusted Signing** cert (skip EV) and **ship it as a bare exe** (it's SSH-pushed). Lay out a
**3-crate workspace** (`protocol`, `controller`, `agent`) with the agent's Windows deps target-gated
and `default-members` excluding it on macOS. License **`MIT OR Apache-2.0`**, preserve IronRDP's
notices, enforce with `cargo deny` + clippy/fmt gates.
