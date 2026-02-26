import { getAlwaysLoadedContexts, loadContext, listContexts } from './context.js';
import { getDailySoFar } from './journal.js';
import { getSkillsSummary } from './skills.js';
import { listCustomTools } from './custom-tools.js';
import { getCapabilitySummary } from './capabilities.js';
import { getDailySpend } from './cost-tracker.js';
import { listOutfits } from './outfit.js';
import { getPersonality } from './personality.js';
import { getUserRules } from './rules.js';
import config from '../config.js';

// Get available contexts summary
async function getContextSummary() {
  try {
    const ctxs = await listContexts();
    return ctxs.filter(c => !c.alwaysLoad).map(c => `  ${c.name} [${c.type}]`).join('\n');
  } catch { return ''; }
}

export async function buildSystemPrompt(extraContextNames = [], outfit = null) {
  const parts = [];

  // ═══ Parallel fetch all independent data ═══
  const [alwaysLoaded, spend, daily, ctxSummary, skillsSummary, customTools, capSummary, outfitsList, personality, userRules] =
    await Promise.all([
      getAlwaysLoadedContexts(),
      getDailySpend().catch(() => null),
      getDailySoFar().catch(() => null),
      getContextSummary(),
      getSkillsSummary().catch(() => ''),
      listCustomTools().catch(() => []),
      getCapabilitySummary().catch(() => ''),
      listOutfits().catch(() => []),
      getPersonality().catch(() => null),
      getUserRules().catch(() => null),
    ]);

  // ═══ 1. IDENTITY (always-loaded contexts: _identity.md, etc.) ═══
  for (const ctx of alwaysLoaded) {
    parts.push(ctx.content);
  }

  // ═══ 1b. USER RULES (persistent, highest priority after identity) ═══
  if (userRules) {
    parts.push(`--- User Rules (MANDATORY — these override all other instructions) ---\n${userRules}`);
  }

  // ═══ 1c. PERSONALITY (agent-editable self-expression) ═══
  if (personality) {
    parts.push(`--- Personality ---\n${personality}`);
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

  // ═══ 5b. OUTFIT ═══
  if (outfit?.content) {
    parts.push(`--- Outfit: ${outfit.name} ---\n${outfit.content}`);
  }
  if (outfit?.tools?.length) {
    parts.push(`Active tool restriction: ${outfit.tools.length} tools. Use remove_outfit() to restore full access.`);
  }

  // ═══ 5c. AVAILABLE OUTFITS ═══
  if (outfitsList.length > 0 && !outfit) {
    const listing = outfitsList.map(o => `  ${o.name} — ${o.description}`).join('\n');
    parts.push(`--- Outfits (wear_outfit to activate) ---\n${listing}`);
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

  // ═══ 10. BEHAVIORAL RULES (universal — mode-specific rules live in outfits/contexts) ═══
  const p = config.para;
  parts.push(`--- Rules ---
VAULT: ${p.inbox}/ (inbox), ${p.projects}/, ${p.resources}/, ${config.dailyNotesDir}/ (journal).
WORKSPACE: Use ws:// prefix for code and projects (e.g. write_file("ws://myapp/src/app.js", ...)). Never write code to the vault.
- journal_append() is your PRIMARY write target. Most things go in the daily journal.
- Journal sections: Notes (default), Tasks, Decisions. Don't create extra sections.
- Use remember() for persistent knowledge — stores to the knowledge graph, not the vault.

JUDGMENT:
- JUST DO IT. Don't ask "would you like me to...?" — the request IS the permission.
- Acknowledge first — 1-2 sentences of what you're about to do, then execute. Critical for Telegram/async.
- Use notify_user() to reach the user. Use tools when there's real work — don't investigate when the answer is in front of you.

OUTFITS:
- Wear an outfit before focused work — wear_outfit("coding") for dev, wear_outfit("research") for reading. This is your FIRST action when starting a task.
- Skip outfits only for trivial one-shot requests.

BIG TASKS:
- Acknowledge → task_plan → execute subtasks → spawn_subagent for independent work → mark done. Don't ask between steps.

HONESTY:
- NEVER fabricate tool output, search results, or data you didn't retrieve. If something fails, say so.

SECURITY:
- NEVER write credentials to vault files. Use store_credential() only.

RULES:
- When the user says "never do X" or "always do Y", use add_rule() to persist it. Rules override everything and apply to ALL sessions including heartbeat.
- Personality is for style. Rules are for boundaries. Don't mix them.`);

  return parts.join('\n\n');
}

export function estimateSystemTokens(systemPrompt) {
  return Math.ceil(systemPrompt.length / 4);
}
