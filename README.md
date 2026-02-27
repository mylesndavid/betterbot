# BetterBot

A zero-dependency AI agent framework that lives in your Obsidian vault. Name your agent, give it a personality, and let it manage your calendar, email, tasks, and projects autonomously — building its own tools, scheduling its own crons, and waking itself up when there's work to do.

## What it does

- **Persistent agent** — Your agent reads and writes to your Obsidian vault. The daily journal is its memory. Context files define its identity. You name it, you shape it — and it shapes itself.
- **3-tier heartbeat** — Checks for new tasks every 15 minutes. Cheap triage decides what matters, a lightweight agent handles simple stuff, and the full agent escalates for complex work.
- **Self-building tools** — The agent creates its own tools as ES module files. Need a Telegram bot? It builds it. Need calendar access? It writes the AppleScript wrapper.
- **Outfits** — Switchable bundles of tools, contexts, and personality. The agent wears a "coding" outfit for dev work, a "research" outfit for investigation, and can create its own.
- **Personality** — The agent has a self-editable personality file. It defines its own voice, tone, quirks, and rules — separate from the core identity you set. It evolves over time.
- **Graph memory** — Compaction summaries feed a persistent knowledge graph. Entities, people, decisions, and relationships are extracted automatically. `recall()` searches the graph for connected knowledge across sessions.
- **Do mode** — For big tasks ("build me an app"), the agent plans subtasks, tracks progress, and spawns sub-agents with full tool access to parallelize work.
- **Long tasks** — Time and cost-bounded autonomous agents for ambitious work (deep research, apartment hunting, building apps). Runs in the background, saves findings progressively to the vault, and notifies you when done.
- **Multi-channel** — Web panel, Telegram, Slack, CLI. Notifications route to wherever you are.
- **Zero dependencies** — Node.js built-ins, `fetch()`, no npm packages. Runs on a single `node` process.

## Quick start

```bash
# Install
# Option 1: curl installer
curl -sL https://raw.githubusercontent.com/mylesndavid/betterbot/main/install.sh | bash

# Option 2: git clone
git clone https://github.com/mylesndavid/betterbot.git ~/.betterclaw/app
cd ~/.betterclaw/app && npm link

# Configure (guided wizard — vault, provider, API key, models, capabilities)
betterbot init

# Start the gateway (panel + telegram + heartbeat + crons)
betterbot gateway

# Or just chat
betterbot chat
```

## Architecture

```
bin/betterbot           CLI entry point (init, chat, gateway, setup, doctor)
lib/gateway.js          Persistent service: panel + telegram + heartbeat + crons
lib/heartbeat.js        3-tier: cheap triage → disposable agent → full session
lib/session.js          Conversation sessions with tool loops and compaction
lib/tools.js            Built-in tools (50+) + custom tool registry
lib/agent.js            Sub-agent spawning + long task runner (non-blocking)
lib/identity.js         System prompt builder (identity, personality, contexts, rules)
lib/outfit.js           Switchable tool + context + personality bundles
lib/personality.js      Agent-editable personality file
lib/graph.js            Minimal pure-JS directed graph (zero deps)
lib/graph-memory.js     Extract entities from compactions → graph, semantic recall
lib/slack.js            Built-in Slack integration (read/send)
lib/panel/              Web UI (single HTML file, Node HTTP server)
lib/custom-tools.js     Self-building tool system (ES module JS files)
lib/skills.js           Markdown procedural knowledge in vault
lib/crons.js            User-scheduled recurring tasks
lib/channels/           Channel adapters (CLI, Telegram, heartbeat)
contexts/               Identity, capability docs, coding guidance
```

## Config

All config lives in `~/.betterclaw/config.json`. Set your vault path, model provider (OpenRouter, Anthropic, OpenAI, Ollama, Together, Groq), daily budget, and heartbeat sources. Run `betterbot init` for guided setup.

Models are configured by role:
- **router** — cheapest, used for heartbeat triage classification
- **quick** — fast, used for disposable agents, compaction, and graph extraction
- **default** — balanced, main conversational agent
- **deep** — most capable, used for complex reasoning and sub-agents

## Key concepts

**Vault** — Your Obsidian vault. The human-facing layer — journal entries, project docs, research briefs, skills. The daily journal is the primary write target. Organized as Inbox, Projects, Resources, and Daily.

**Workspace** — Where code projects live (`~/.betterclaw/workspace/`). Use `ws://` prefix in file paths to target it.

**Contexts** — Markdown files injected into the system prompt. Always-loaded ones (prefixed with `_`) define the agent's core identity. Others load on demand with `load_context("coding")`. Capability docs (`cap-*`) provide setup instructions.

**Outfits** — Reusable bundles of tools, contexts, and personality stored in `~/.betterclaw/outfits/`. When the agent wears an outfit, its tools are restricted to the whitelist, contexts are auto-loaded, and personality text is injected. The agent wears outfits before focused work — `coding` for dev, `research` for investigation — and can create new ones.

**Personality** — The agent's self-editable identity file at `~/.betterclaw/personality.md`. Separate from the core identity (which is fixed by the developer). The agent defines its own voice, tone, quirks, constraints, and rules here using `edit_personality()` or `add_personality_rule()`. Persists across all sessions.

**Graph memory** — The agent's brain. A persistent knowledge graph at `~/.betterclaw/graph/`. All memory lives here — `remember()` writes graph nodes, `recall()` searches them. Compaction summaries automatically extract entities, people, decisions, and relationships into connected nodes. The graph is the single source of truth for what the agent knows.

**Custom tools** — The agent builds tools as ES module files in `~/.betterclaw/custom-tools/`. They persist across sessions and auto-load on startup. Each tool is validated on creation.

**Skills** — Markdown docs describing multi-step procedures. The agent creates and references them for repeatable workflows. Stored in the vault.

**Task plan** — In-session self-organization. The agent breaks big tasks into subtasks, tracks progress, and spawns sub-agents for parallel work.

**Long tasks** — For sustained autonomous work that needs real time (research, building, analysis). The `long_task` tool spawns a dedicated agent with configurable time and cost limits. It runs in the background — saves a research log, individual findings, and a summary index to the vault — and notifies you when done. Use `check_long_task` to monitor progress mid-flight.

**Capabilities** — Registry of what the agent can and can't do (email, calendar, Telegram, Slack, GitHub, search, etc.). Shown in the system prompt. The agent can set up missing capabilities itself or guide you through `betterbot setup <name>`.

## Built-in channels

| Channel | Description | Setup |
|---------|-------------|-------|
| **CLI** | Interactive terminal chat | `betterbot chat` |
| **Web Panel** | Browser UI at localhost:3333 | `betterbot gateway` or `betterbot panel` |
| **Telegram** | Two-way messaging via bot | `betterbot setup telegram` |
| **Slack** | Read channels, send messages | `betterbot setup slack` |

## CLI commands

```
betterbot init              Guided setup wizard
betterbot chat              Interactive CLI chat
betterbot gateway           Start persistent service
betterbot gateway install   Install as macOS LaunchAgent
betterbot setup <name>      Set up a capability (telegram, email, slack, search, etc.)
betterbot doctor            Diagnose issues (--fix to auto-repair)
betterbot model             Show/change model config
betterbot ctx list          List available contexts
betterbot search <query>    Search Obsidian vault
betterbot sessions          List saved sessions
betterbot creds list        Show configured credentials
betterbot version           Show version
```

## Requirements

- Node.js 20+
- macOS (for Calendar/Reminders via AppleScript, Keychain for credentials)
- An LLM provider API key (OpenRouter recommended for multi-model access)
