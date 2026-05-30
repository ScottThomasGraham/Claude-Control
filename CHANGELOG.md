# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project will adopt
[Semantic Versioning](https://semver.org/) once it ships releases.

## [Unreleased]

### Added
- Initial design specification for Claude-Control — a tri-channel (SSH + RDP + UIA agent) controller
  for remote Windows desktops, drivable by an AI agent and a human.
- Sourced feasibility research: IronRDP (RDP engine), Windows SSH/OpenSSH (fast path + bootstrap),
  Windows UIA helper agent (semantic perception + auto-rollout), distribution/packaging/CI, and
  OCR/perception on macOS.
- Implementation roadmap (5 phases) and a detailed, bite-sized Phase 1 plan (SSH fast path).

_No application code yet — implementation begins after design approval._
