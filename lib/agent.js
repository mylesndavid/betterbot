import { Session } from './session.js';
import { appendEntry } from './journal.js';

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
