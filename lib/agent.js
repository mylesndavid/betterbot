import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Session } from './session.js';
import { appendEntry } from './journal.js';
import { notifyUser } from './notify.js';
import config from '../config.js';

const DEFAULT_SUBAGENT_ROUNDS = 20;
const DEFAULT_COST_CEILING = 0.50; // $0.50 per sub-agent

// Full sub-agent: gets its own Session with tools, runs autonomously
export async function spawnSessionAgent(task, opts = {}) {
  const role = opts.role || 'default';
  const maxToolRounds = opts.maxToolRounds || DEFAULT_SUBAGENT_ROUNDS;
  const costCeiling = opts.costCeiling ?? DEFAULT_COST_CEILING;

  const session = new Session({
    role,
    maxToolRounds,
    costCeiling,
  });
  await session.init();

  const taskPrompt = `You are a sub-agent spawned to complete a specific task. You have full tool access. Work autonomously — complete the task, then provide a concise summary of what you did and the results.

Task: ${task}

${opts.context || ''}`;

  const result = await session.send(taskPrompt);

  // Don't log sub-agent spawns to the journal by default
  if (opts.journal === true && opts.journalSection) {
    await appendEntry(`**Sub-agent (${role}):** ${task.slice(0, 80)}`, opts.journalSection);
  }

  return {
    content: result.content,
    sessionId: session.id,
    cost: session.metadata.cost.total,
    role,
  };
}

// Run a batch of tasks in parallel
export async function spawnAgents(tasks) {
  return Promise.all(tasks.map(t => spawnSessionAgent(t.task, t.opts)));
}

// Legacy alias
export const spawnAgent = spawnSessionAgent;

// --- Long Task: time/cost-bounded autonomous agent (non-blocking) ---

const DEFAULT_LONG_TASK_MINUTES = 15;
const DEFAULT_LONG_TASK_COST = 2.00;
const DEFAULT_LONG_TASK_ROUNDS = 200;

if (!global._longTasks) global._longTasks = new Map();

function generateFolder(task) {
  const slug = task.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const date = new Date().toISOString().slice(0, 10);
  return `${slug}-${date}`;
}

function buildLongTaskPrompt(task, folderPath, timeLimitMin, costLimit) {
  return `You are running a long autonomous task with a time budget of ${timeLimitMin} minutes and a cost budget of $${costLimit.toFixed(2)}. Your remaining budget is shown in your system prompt and updates every turn.

## Your Task
${task}

## Research Strategy
Follow this phased approach:

### Phase 1: Survey (first ~25% of budget)
- Start with web_search to get a broad overview of the topic
- Browse 2-3 different sources (news articles, blogs, official sites) to understand the landscape
- DON'T go deep on any single source yet — map the territory first
- After surveying, update _log.md with what you've learned and create your task_plan

### Phase 2: Deep Dive (middle ~50% of budget)
- Now go deep on each area identified in Phase 1
- Use browse_web to read detailed pages, documentation, comparisons
- Save each major finding as its own file (e.g., "option-1.md", "comparison.md")
- Append to _log.md after every tool call — what did you just learn?

### Phase 3: Synthesize (last ~25% of budget)
- Create _index.md with a summary and [[wikilinks]] to every file
- Fill any gaps you noticed during the deep dive
- If the user would benefit from a comparison table or recommendation, add it

## Output Folder
Save ALL work to: ${folderPath}/
- First action: create _log.md with your initial understanding and plan
- Append to _log.md after EVERY browse/search — one line per discovery
- Save deliverables as separate files with descriptive names
- Last action: create _index.md linking everything together

## Rules
- Use task_plan to structure your work and track progress
- Use web_search and browse_web extensively — don't rely on a single source
- Use write_file to save progressively — never wait until the end
- Append to _log.md after every tool call with what you learned (even if minor)
- Use notify_user only for truly urgent/significant discoveries
- When budget is low (< 2 minutes or < 20% cost remaining), move to Phase 3
- Finish early if the task is genuinely complete — don't waste budget`;
}

// Internal: runs the long task session to completion, updates global state
async function runLongTaskSession(taskId, task, opts) {
  const entry = global._longTasks.get(taskId);
  const timeLimitMin = opts.timeLimitMinutes || DEFAULT_LONG_TASK_MINUTES;
  const costLimit = opts.costLimit || DEFAULT_LONG_TASK_COST;
  const deadline = Date.now() + timeLimitMin * 60 * 1000;

  const session = new Session({
    role: opts.role || 'default',
    maxToolRounds: DEFAULT_LONG_TASK_ROUNDS,
    costCeiling: costLimit,
    deadline,
  });
  await session.init();
  entry.session = session;

  // Create output folder in vault
  const fullFolderPath = join(config.vault, entry.outputFolder);
  if (!existsSync(fullFolderPath)) {
    await mkdir(fullFolderPath, { recursive: true });
  }

  const prompt = buildLongTaskPrompt(task, entry.outputFolder, timeLimitMin, costLimit);
  const result = await session.send(prompt);

  entry.status = 'completed';
  entry.completedAt = new Date().toISOString();
  entry.result = result.content;

  // Notify user that the long task finished
  const summary = `Long task completed (${taskId}): ${task.slice(0, 60)}${task.length > 60 ? '...' : ''}\nCost: $${session.metadata.cost.total.toFixed(4)} | Output: ${entry.outputFolder}`;
  try { await notifyUser(summary); } catch {}
}

// Spawns a long task in the background — returns immediately
export async function spawnLongTask(task, opts = {}) {
  const taskId = randomUUID().slice(0, 8);
  const outputFolder = `Projects/${opts.outputFolder || generateFolder(task)}`;

  const entry = {
    id: taskId,
    task: task.slice(0, 200),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    outputFolder,
    session: null, // set once session is created
    result: null,
    error: null,
  };
  global._longTasks.set(taskId, entry);

  // Fire and forget — don't await
  runLongTaskSession(taskId, task, opts).catch(err => {
    entry.status = 'failed';
    entry.completedAt = new Date().toISOString();
    entry.error = err.message;
  });

  return { taskId, outputFolder };
}

// Check status of long tasks
export function checkLongTask(taskId) {
  if (taskId) {
    const entry = global._longTasks.get(taskId);
    if (!entry) return `No long task found with ID "${taskId}".`;
    return formatTaskEntry(entry);
  }
  // List all
  if (global._longTasks.size === 0) return 'No long tasks have been started.';
  const lines = [];
  for (const entry of global._longTasks.values()) {
    lines.push(formatTaskEntry(entry));
  }
  return lines.join('\n\n---\n\n');
}

function formatTaskEntry(entry) {
  const cost = entry.session?.metadata?.cost?.total ?? 0;
  const elapsed = Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const icon = entry.status === 'running' ? '●' : entry.status === 'completed' ? '✓' : '✗';
  let out = `${icon} Task ${entry.id} — ${entry.status}\n  "${entry.task}"\n  Elapsed: ${elapsedStr} | Cost: $${cost.toFixed(4)} | Output: ${entry.outputFolder}`;
  if (entry.status === 'completed' && entry.result) {
    out += `\n\nResult:\n${entry.result}`;
  }
  if (entry.status === 'failed' && entry.error) {
    out += `\n\nError: ${entry.error}`;
  }
  return out;
}
