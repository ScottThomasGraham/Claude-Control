# Contributing

Thanks for your interest in Claude-Control. The project is in the **design phase** — the most useful
contributions right now are review and discussion of the [spec](docs/superpowers/specs/) and
[plans](docs/superpowers/plans/).

## Development workflow (once implementation starts)

- **TDD:** write a failing test, watch it fail, implement the minimum to pass, commit. Plans are
  written as bite-sized red→green→commit steps.
- **Branch off `main`**; open a PR. Keep commits small and logically scoped.
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

## Required checks (CI gates)

Before a PR can merge, all of these must pass on macOS and Windows runners:

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo deny check        # license + advisory policy
```

## Project shape

A Cargo workspace: `crates/protocol` (shared types, builds everywhere), `crates/controller` (the
`ctl` macOS binary), `crates/agent` (Windows-only UIA helper). Windows-only dependencies are
target-gated so the workspace builds on macOS; `default-members` excludes the agent from a bare
`cargo build` on a Mac. See the [roadmap](docs/superpowers/plans/2026-05-30-claude-control-roadmap.md)
for the file structure and conventions.

## Licensing

By contributing you agree your contributions are dual-licensed under **MIT OR Apache-2.0**, matching
the project license. Preserve upstream license/NOTICE files for vendored or wrapped dependencies
(e.g. IronRDP).
