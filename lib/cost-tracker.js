import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import config from '../config.js';

const COST_LOG_PATH = join(config.dataDir, 'cost-log.json');

// Cost per 1M tokens by model
const RATES = {
  'anthropic/claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'openai/o3': { input: 2.00, output: 8.00 },
  'openrouter/google/gemini-3-flash-preview': { input: 0.10, output: 0.40 },
  'openrouter/google/gemini-2.0-flash-lite-001': { input: 0.04, output: 0.15 },
  'openrouter/moonshotai/kimi-k2.5': { input: 0.20, output: 0.80 },
  'openrouter/google/gemini-2.5-pro-preview': { input: 1.25, output: 10.00 },
  '_default': { input: 1.00, output: 4.00 },
};

function getModelKey(role) {
  const spec = config.models[role];
  if (!spec) return null;
  return `${spec.provider}/${spec.model}`;
}

function getRates(modelKey) {
  return RATES[modelKey] || RATES['_default'];
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function loadLog() {
  try {
    const raw = await readFile(COST_LOG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveLog(log) {
  if (!existsSync(config.dataDir)) {
    await mkdir(config.dataDir, { recursive: true });
  }
  await writeFile(COST_LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

/**
 * Track token usage after an API call.
 * @param {string} role - Model role (default, quick, deep, browser, etc.)
 * @param {object} usage - { input, output } token counts
 */
export async function trackUsage(role, usage) {
  if (!usage || (!usage.input && !usage.output)) return;

  const modelKey = getModelKey(role);
  const rates = getRates(modelKey);
  const cost = (usage.input * rates.input + usage.output * rates.output) / 1_000_000;

  const log = await loadLog();
  const day = todayKey();

  if (!log[day]) {
    log[day] = { totalCost: 0, calls: 0, byRole: {} };
  }

  const entry = log[day];
  entry.totalCost = Math.round((entry.totalCost + cost) * 1_000_000) / 1_000_000;
  entry.calls++;

  if (!entry.byRole[role]) {
    entry.byRole[role] = { input: 0, output: 0, cost: 0 };
  }
  const roleEntry = entry.byRole[role];
  roleEntry.input += usage.input;
  roleEntry.output += usage.output;
  roleEntry.cost = Math.round((roleEntry.cost + cost) * 1_000_000) / 1_000_000;

  // Prune entries older than 30 days
  const keys = Object.keys(log).sort();
  while (keys.length > 30) {
    delete log[keys.shift()];
  }

  await saveLog(log);
}

/**
 * Get today's total spend.
 * @returns {{ totalCost: number, calls: number, byRole: object }}
 */
export async function getDailySpend() {
  const log = await loadLog();
  const day = todayKey();
  return log[day] || { totalCost: 0, calls: 0, byRole: {} };
}

/**
 * Check if the daily budget is exceeded.
 * @returns {{ ok: boolean, spend: number, limit: number, warning: boolean }}
 */
export async function checkBudget() {
  const daily = await getDailySpend();
  const limit = config.budget?.dailyLimit ?? 2.00;
  const warnAt = config.budget?.warnAt ?? 1.50;

  return {
    ok: daily.totalCost < limit,
    spend: daily.totalCost,
    limit,
    warning: daily.totalCost >= warnAt,
    calls: daily.calls,
    byRole: daily.byRole,
  };
}

/**
 * Format the budget status for display.
 */
export async function formatBudgetStatus() {
  const { spend, limit, calls, byRole } = await checkBudget();
  const lines = [`Budget: $${spend.toFixed(2)} / $${limit.toFixed(2)} today (${calls} calls)`];

  for (const [role, data] of Object.entries(byRole)) {
    lines.push(`  ${role}: ${data.input.toLocaleString()} in / ${data.output.toLocaleString()} out — $${data.cost.toFixed(4)}`);
  }

  return lines.join('\n');
}
