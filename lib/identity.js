import { getAlwaysLoadedContexts, loadContext, listContexts } from './context.js';
import { getDailySoFar } from './journal.js';
import { getSkillsSummary } from './skills.js';
import { listCustomTools } from './custom-tools.js';
import { getCapabilitySummary } from './capabilities.js';
import config from '../config.js';

// Get available contexts summary
async function getContextSummary() {
  try {
    const ctxs = await listContexts();
    return ctxs.filter(c => !c.alwaysLoad).map(c => `  ${c.name} [${c.type}]`).join('\n');
  } catch { return ''; }
}

export async function buildSystemPrompt(extraContextNames = []) {
  const parts = [];

  // ═══ 1. IDENTITY (always-loaded contexts: _identity.md, etc.) ═══
  const alwaysLoaded = await getAlwaysLoadedContexts();
  for (const ctx of alwaysLoaded) {
    parts.push(ctx.content);
  }

  // ═══ 2. SITUATIONAL AWARENESS ═══
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toISOString().slice(0, 10);
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' });

  parts.push(`--- Situational Awareness ---
${timeStr}, ${dayStr}, ${dateStr}
Model: ${config.models?.default?.provider}/${config.models?.default?.model}`);

  // ═══ 3. TODAY'S JOURNAL ═══
  const daily = await getDailySoFar();
  if (daily) {
    const content = daily.replace(/^---[\s\S]*?---\s*/, '');
    parts.push(`--- Today's Journal (${dateStr}) ---\n${content.trim()}`);
  }

  // ═══ 5. LOADED CONTEXTS ═══
  for (const name of extraContextNames) {
    const ctx = await loadContext(name);
    if (ctx) {
      parts.push(`--- Context: ${ctx.name} ---\n${ctx.content}`);
    }
  }

  // ═══ 6. AVAILABLE CONTEXTS ═══
  const ctxSummary = await getContextSummary();
  if (ctxSummary) {
    parts.push(`--- Contexts (load_context to activate) ---\n${ctxSummary}`);
  }

  // ═══ 7. SKILLS ═══
  const skillsSummary = await getSkillsSummary();
  if (skillsSummary) {
    parts.push(skillsSummary);
  }

  // ═══ 8. CUSTOM TOOLS ═══
  try {
    const customTools = await listCustomTools();
    if (customTools.length > 0) {
      const listing = customTools.map(t => `  ${t.name} — ${t.description}`).join('\n');
      parts.push(`--- Custom Tools ---\n${listing}`);
    }
  } catch {}

  // ═══ 9. CAPABILITIES ═══
  try {
    const capSummary = await getCapabilitySummary();
    if (capSummary) {
      parts.push(`--- Capabilities ---\n${capSummary}`);
    }
  } catch {}

  // ═══ 10. BEHAVIORAL RULES ═══
  const p = config.para;
  parts.push(`--- Rules ---
VAULT: ${p.inbox}/ (inbox), ${p.projects}/, ${p.areas}/, ${p.resources}/, ${p.archive}/, ${config.dailyNotesDir}/ (journal), ${config.memoriesDir}/ (persistent notes).
WORKSPACE: Use ws:// prefix for code and projects (e.g. write_file("ws://yapdo/src/app.js", ...)). Never write code to the vault.
- journal_append() is your PRIMARY write target. Most things go in the daily journal.
- Journal sections are: Notes (default), Tasks, Decisions. Do NOT create extra sections.
- Keep entries concise. One line per entry. No bold timestamps — the function adds them automatically.
- Only create separate vault files for research, briefs, or docs the user explicitly requests.
- Use ${config.memoriesDir}/ for persistent knowledge — things worth remembering across days.
- Never scatter files at the vault root. Use the folders above.

TASKS & SELF-WAKE:
- Open tasks in the daily note (\`- [ ] ...\`) are picked up by the heartbeat every 15 min.
- Tag a task with #main to route it directly to you (the full agent) on the next heartbeat, skipping triage. Use this to wake yourself up later.
- Tag a task with #act to route it to the lightweight ACT agent.
- Untagged tasks go through triage (cheap model decides).
- When you're blocked or waiting on something, write a #main task describing what to do when unblocked. You'll get woken up with it.
- Example: \`- [ ] #main Investigate yapdo codebase — user will provide repo URL\`

BROWSING:
- browse_web(url, task) is a core tool. Use it freely for research, reading pages, filling forms, checking dashboards, or any web interaction.
- It uses ARIA snapshots (text, not screenshots) — very cheap (~$0.01 per session). Don't hesitate to browse.
- The browser can use the user's Chrome cookies for authenticated sites (Twitter, GitHub, etc.) when useProfile is enabled.

JUDGMENT:
- Conversational for chat. Use tools when asked to find, read, create, or check something.
- Keep tool use purposeful. Don't call get_credential() to check what's configured — your Capabilities section already tells you.
- Use notify_user() to reach the user — it routes to their configured channel and preserves reply context.
- Custom tools that use credentials fetch them internally — just pass content params.
- Be proactive. If you see something that needs doing, do it.
- If a capability is inactive and just needs a tool built (no API key), build it immediately.
- If it needs credentials or setup, load the cap-* context for details. For channels (telegram, email, slack), recommend: "run claw setup <name>" for the guided wizard. You can also store credentials directly with store_credential().

HONESTY:
- NEVER fabricate tool output. If a tool call fails or a tool is unavailable, say so clearly.
- NEVER invent search results, page content, or data you didn't actually retrieve.
- If you can't do something, say "I can't do that right now" — don't pretend.

SECURITY:
- NEVER write credentials, passwords, API keys, or tokens to vault files.
- Always use store_credential() for secrets. If you find credentials in vault files, move to Keychain and delete the file.`);

  return parts.join('\n\n');
}

export function estimateSystemTokens(systemPrompt) {
  return Math.ceil(systemPrompt.length / 4);
}
