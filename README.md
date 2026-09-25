# SLOPWARE

This repository is a collection of small applications generated end-to-end by AI coding assistants — specifically **Codex + GPT-6 Astra** and **Claude Code Opus 5**. Even this README.md is AI Generated. Each subdirectory is a self-contained application with its own README, license, and documentation.

## Applications

| Directory | Description | AI Agent |
| --- | --- | --- |
| [`frisbee/`](frisbee/) | A standard-library Python server for LAN file sharing and shared notes. | Codex + GPT-6 Astra + Ultra |
| [`guanaco/`](guanaco/) | A browser-based workspace for queued Ollama conversations. | Codex + GPT-6 Astra + Ultra |
| [`pellets/`](pellets/) | A Node.js real-time chat server that keeps nothing on disk. | Claude Code + Opus 5 + Max |
| [`reptile/`](reptile/) | A Node.js tool that keeps one directory identical on two LAN computers, in real time and both ways, over HTTP or HTTPS. | Claude Code + Opus 5.5 + Max |

## Conventions

- Every application lives in its own top-level directory and is independently runnable; there is no shared build system or dependency graph across apps.
- Each application's `README.md` documents its own setup and usage. Start there.
- Each application's `AGENTS.md`/`CLAUDE.md` (when present) is the handoff entry point for an AI coding assistant working on that app, and documents which AI tools were used to create and maintain it.
- Each application's `prompts/init.md` (when present) keeps the original prompt used to generate it.
- [`.claude/skills/new-app/SKILL.md`](.claude/skills/new-app/SKILL.md) records the conventions a new application must follow. It is packaged as a Claude Code skill, but the body is plain Markdown with no Claude-specific machinery: any assistant, Codex included, can be pointed at that path and read it as a checklist.

## Developer Comments

Both Frisbee and Guanaco, generated with Codex + GPT-6 Astra in effort Ultra and 20USD suscription, took all the 100% tokens window that restart every 5 hours at least one time and then ~70% of tokens to finish the application.

Pellets was generated using Claude Code + Opus 5 + effort Max on the 20USD suscription and it only took ~55% of tokens.
