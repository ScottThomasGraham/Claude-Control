# Research: perception layer (OCR + element detection)

*Captured 2026-05-30. Sourced web research synthesized into a brief.*

The baseline (no helper agent) case gives the controller only the **pixel framebuffer**. Goal: from a
screenshot, produce a legend of on-screen text + likely-interactive widgets with center coordinates,
so the LLM agent can target clicks reliably. Controller runs in Rust on macOS.

## 1. OCR options callable from Rust on macOS

**ocrs (pure-Rust, robertknight)** — Rust OCR library + CLI on the author's `rten` ONNX runtime. Two
small models (detection + recognition), auto-downloaded to `~/.cache/ocrs` but trivially bundle-able
(tens of MB). Fully offline, no system libs, cross-compiles (even WASM). Dual **MIT/Apache-2.0**.
Maturity: self-described *"early preview… expect more errors than commercial engines"*; layout phase
is hand-written/brittle; Latin alphabet only. Easiest to embed (`cargo add ocrs`).
([repo](https://github.com/robertknight/ocrs), [models](https://github.com/robertknight/ocrs-models))

**Tesseract bindings** — `rusty-tesseract` shells out (fragile); `leptess`/`tesseract` are
libtesseract+leptonica FFI needing `brew install tesseract leptonica` + clang (system-dependency
burden, distribution headache); `tesseract-rs` compiles from source (self-contained but heavy). OK
accuracy on clean text, weaker on sparse desktop chrome.

**Apple Vision (`VNRecognizeTextRequest`)** — built into macOS, on-device, offline, zero
install/bundle footprint, **best accuracy** especially on UI text. Callable from Rust via the
maintained **`objc2-vision`** bindings (no Swift shim required). Cost: macOS-only (irrelevant — our
controller *is* macOS). ([objc2-vision](https://docs.rs/objc2-vision/),
[VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest))

| | Accuracy | Offline | Install/bundle | License |
|---|---|---|---|---|
| ocrs | Good (preview) | Yes | None; bundle ~models | MIT/Apache |
| Tesseract FFI | OK | Yes | Heavy (brew/dylibs) | Apache-2.0 |
| Apple Vision | Excellent | Yes | None (built-in) | OS framework |

## 2. Word/line bounding boxes
All three give geometry. ocrs returns per-word and per-line boxes. Tesseract exposes word/line/char
boxes (hOCR/TSV). Apple Vision returns `VNRecognizedTextObservation` with a normalized box per string
and `boundingBox(for:)` for tighter per-substring boxes — easily converted to pixel centers.

## 3. UI element detection beyond text
Classical CV (edges/contours via `image`+`imageproc`) finds rectangles but is noisy/low-precision on
flat modern UIs (Win11, Electron); **UIED** is the reference CV pipeline (heavy heuristics). The
credible ML route is **OmniParser** (YOLOv8-nano icon detector + caption + OCR), but it's a
Python/torch stack, not cleanly Rust-embeddable. For a clean Rust tool, neither is worth the weight:
text+box legend plus the LLM's own visual reasoning is the pragmatic baseline.
([UIED](https://github.com/MulongXie/UIED), [OmniParser](https://github.com/microsoft/OmniParser))

## Bottom line
**Default to Apple Vision via `objc2-vision`** — already on every macOS host, fully offline, zero
footprint, per-line/per-substring boxes for click targeting, most accurate; the macOS-only cost is
moot. Keep **ocrs as a portable fallback** (pure-Rust, bundle the two small models) for non-Apple
hosts or to avoid OS coupling. Skip Tesseract. **Defer element detection to the LLM:** feed it the
screenshot + OCR legend (text + center coords) and let visual reasoning identify clickable widgets.
Add a CV/OmniParser-style detector only if icon-only targeting proves unreliable in practice.
