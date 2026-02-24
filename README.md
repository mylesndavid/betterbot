# BetterBot

A zero-dependency AI agent framework that lives in your Obsidian vault. Name your agent, give it a personality, and let it manage your calendar, email, tasks, and projects autonomously — building its own tools, scheduling its own crons, and waking itself up when there's work to do.

## What it does

- **Persistent agent** — Your agent reads and writes to your Obsidian vault. The daily journal is its memory. Context files are its personality. You name it, you shape it.
- **3-tier heartbeat** — Checks for new tasks every 15 minutes. Cheap triage decides what matters, a lightweight agent handles simple stuff, and the full agent escalates for complex work.
- **Self-building tools** — The agent creates its own tools as ES module files. Need a Telegram bot? It builds it. Need calendar access? It writes the AppleScript wrapper.
- **Do mode** — For big tasks ("build me an app"), the agent plans subtasks, tracks progress, and spawns sub-agents with full tool access to parallelize work.
- **Multi-channel** — Web panel, Telegram, CLI. Notifications route to wherever you are.
- **Zero dependencies** — Node.js built-ins, `fetch()`, no npm packages. Runs on a single `node` process.

## Quick start

```bash
# Install
curl -sL https://raw.githubusercontent.com/mylesndavid/betterbot/main/install.sh | bash

# Configure
source ~/.zshrc && betterbot init

# Start the gateway (panel + telegram + heartbeat + crons)
betterbot gateway

# Or just chat
betterbot chat
```

## Architecture

```
bin/betterbot              CLI entry point
lib/gateway.js        Persistent service: panel + telegram + heartbeat + crons
lib/heartbeat.js      3-tier: cheap triage -> disposable agent -> full session
lib/session.js        Conversation sessions with tool loops and task planning
lib/tools.js          Built-in tools (40+) + custom tool registry
lib/agent.js          Sub-agent spawning with full tool access
lib/identity.js       System prompt builder (situational awareness, rules, context)
lib/panel/            Web UI (single HTML file, Node HTTP server)
lib/custom-tools.js   Self-building tool system (ES module JS files)
lib/skills.js         Markdown procedural knowledge
lib/crons.js          User-scheduled recurring tasks
hardware/             Device design research (handheld AI companion)
```

## Config

All config lives in `~/.betterclaw/config.json`. Set your vault path, model provider (OpenRouter, Anthropic, OpenAI), daily budget, and heartbeat sources.

Models are configured by role:
- **router** — cheapest, used for heartbeat triage classification
- **quick** — fast, used for disposable agents and compaction
- **default** — balanced, main conversational agent
- **deep** — most capable, used for complex reasoning and sub-agents

## Key concepts

**Vault** — Your Obsidian vault. The agent reads/writes notes, journal entries, and memories here.

**Workspace** — Where code projects live. Use `ws://` prefix in file paths.

**Contexts** — Markdown files that get injected into the system prompt. Auto-loaded ones define the agent's identity. Others load on demand (`load_context("coding")`).

**Custom tools** — The agent builds tools as ES module files in `~/.betterclaw/custom-tools/`. They persist across sessions and auto-load on startup.

**Skills** — Markdown docs describing multi-step procedures. The agent creates and references them for repeatable workflows.

**Task plan** — In-session self-organization. The agent breaks big tasks into subtasks, tracks progress, and spawns sub-agents for parallel work.

## Requirements

- Node.js 20+
- macOS (for Calendar/Reminders via AppleScript, Keychain for credentials)
- An LLM provider API key (OpenRouter recommended)
