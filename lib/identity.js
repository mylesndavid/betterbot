import { getAlwaysLoadedContexts, loadContext, listContexts } from './context.js';
import { getDailySoFar } from './journal.js';
import { getSkillsSummary } from './skills.js';
import { listCustomTools } from './custom-tools.js';
import { getCapabilitySummary } from './capabilities.js';
import { getDailySpend } from './cost-tracker.js';
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

  // ═══ Parallel fetch all independent data ═══
  const [alwaysLoaded, spend, daily, ctxSummary, skillsSummary, customTools, capSummary] =
    await Promise.all([
      getAlwaysLoadedContexts(),
      getDailySpend().catch(() => null),
      getDailySoFar().catch(() => null),
      getContextSummary(),
      getSkillsSummary().catch(() => ''),
      listCustomTools().catch(() => []),
      getCapabilitySummary().catch(() => ''),
    ]);

  // ═══ 1. IDENTITY (always-loaded contexts: _identity.md, etc.) ═══
  for (const ctx of alwaysLoaded) {
    parts.push(ctx.content);
  }

  // ═══ 2. SITUATIONAL AWARENESS ═══
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' });

  let budgetLine = '';
  if (spend) {
    const limit = config.budget?.dailyLimit ?? 2.00;
    budgetLine = `\nBudget: $${spend.totalCost.toFixed(2)} / $${limit.toFixed(2)} today (${spend.calls} calls)`;
  }

  parts.push(`--- Situational Awareness ---
${timeStr}, ${dayStr}, ${dateStr}
Model: ${config.models?.default?.provider}/${config.models?.default?.model}${budgetLine}`);

  // ═══ 3. TODAY'S JOURNAL ═══
  if (daily) {
    const content = daily.replace(/^---[\s\S]*?---\s*/, '');
    parts.push(`--- Today's Journal (${dateStr}) ---\n${content.trim()}`);
  }

  // ═══ 5. LOADED CONTEXTS (parallel) ═══
  const extraContexts = await Promise.all(extraContextNames.map(name => loadContext(name).catch(() => null)));
  for (const ctx of extraContexts) {
    if (ctx) {
      parts.push(`--- Context: ${ctx.name} ---\n${ctx.content}`);
    }
  }

  // ═══ 6. AVAILABLE CONTEXTS ═══
  if (ctxSummary) {
    parts.push(`--- Contexts (load_context to activate) ---\n${ctxSummary}`);
  }

  // ═══ 7. SKILLS ═══
  if (skillsSummary) {
    parts.push(skillsSummary);
  }

  // ═══ 8. CUSTOM TOOLS ═══
  if (customTools.length > 0) {
    const listing = customTools.map(t => `  ${t.name} — ${t.description}`).join('\n');
    parts.push(`--- Custom Tools ---\n${listing}`);
  }

  // ═══ 9. CAPABILITIES ═══
  if (capSummary) {
    parts.push(`--- Capabilities ---\n${capSummary}`);
  }

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
- JUST DO IT. When the user asks you to do something, execute. Never ask "would you like me to...?" or "shall I...?" — the request IS the permission. But answer from the conversation first — only reach for tools when the answer isn't already in front of you.
- BUT FIRST, ACKNOWLEDGE. Before kicking off a multi-step task, send a short message saying what you're about to do (1-2 sentences max). "Setting up a Next.js project with a wine catalog. I'll scaffold it, add sample data, and start the dev server." Then go do it. This is especially important for Telegram/async — the user needs to know you heard them and are working.
- Conversational for chat. Use tools when asked to find, read, create, or check something.
- Keep tool use purposeful. Don't call get_credential() to check what's configured — your Capabilities section already tells you.
- Use notify_user() to reach the user — it routes to their configured channel and preserves reply context.
- Custom tools that use credentials fetch them internally — just pass content params.
- Be proactive with tasks. Be fast with questions. If the user is just talking, respond from what you know — don't launch an investigation. Save the tool calls for when there's actual work to do.
- If a capability is inactive and just needs a tool built (no API key), build it immediately.
- If it needs credentials or setup, load the cap-* context for details. For channels (telegram, email, slack), recommend: "run claw setup <name>" for the guided wizard. You can also store credentials directly with store_credential().

CODING & DEVELOPMENT:
- When working on code projects, ALWAYS set the cwd in run_command to the project directory. Discover it once, then reuse it.
- For existing projects on disk, use write_project_file / read_project_file with absolute paths. Don't use write_file with ws:// — that writes to the workspace, not the project.
- For long coding tasks, work in a loop: read → edit → test → fix. Don't stop after one file.
- You can run background processes (dev servers, watchers) with run_background. These survive the session.
- When creating a new project, scaffold it completely — don't ask about each file. Make decisions and ship.
- If a command fails, read the error, fix it, retry. Don't give up after one error.
- Use absolute paths for cwd, not relative paths.
- When verifying your work with browse_web, give the browser agent FULL CONTEXT about what you built and what to check. It has zero knowledge of your conversation.
- For complex projects, use spawn_subagent to parallelize work — e.g. one sub-agent researches an API while you scaffold the project.
- For deep coding sessions, load the "coding" context with load_context("coding") for extra guidance.

DO MODE (big tasks):
- When given a big task (build an app, multi-step project, complex automation), switch to do mode:
  1. Acknowledge briefly what you're about to do (1-2 sentences)
  2. Call task_plan to break it into subtasks
  3. Execute each subtask — don't chat between steps
  4. For independent subtasks, spawn sub-agents to parallelize
  5. Mark tasks done/failed as you go with task_update
  6. If you discover more work, use task_add
  7. Final summary when all tasks are done
- Don't ask "shall I proceed?" between subtasks. The plan IS the permission.
- Sub-agents have full tool access — delegate freely for independent work.

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
