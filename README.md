# SLOPWARE

This repository is a collection of small applications generated end-to-end by AI coding assistants — specifically **Codex + GPT-6 Astra** and **Claude Code Opus 5**. Even this README.md is AI Generated. Each subdirectory is a self-contained application with its own README, license, and documentation.

## Applications

| Directory | Description |
| --- | --- |
| [`frisbee/`](frisbee/) | A standard-library Python server for LAN file sharing and shared notes. |
| [`guanaco/`](guanaco/) | A browser-based workspace for queued Ollama conversations. |
| [`pellets/`](pellets/) | A Node.js real-time chat server that keeps nothing on disk. |

## Conventions

- Every application lives in its own top-level directory and is independently runnable; there is no shared build system or dependency graph across apps.
- Each application's `README.md` documents its own setup and usage. Start there.
- Each application's `AGENTS.md`/`CLAUDE.md` (when present) is the handoff entry point for an AI coding assistant working on that app, and documents which AI tools were used to create and maintain it.
- Each application's `prompts/init.md` (when present) keeps the original prompt used to generate it.
