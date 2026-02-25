import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from './identity.js';
import { extractToGraph, graphRecall } from './graph-memory.js';
import { createProvider, getProviderType } from './provider.js';
import { appendEntry } from './journal.js';
import { getAnthropicTools, getOpenAITools, executeTool, filterToolsByOutfit } from './tools.js';
import { loadOutfit } from './outfit.js';
import { checkBudget, calcCost } from './cost-tracker.js';
import config from '../config.js';

const DEFAULT_MAX_TOOL_ROUNDS = 50; // Safety limit on tool-use loops

export class Session {
  constructor(opts = {}) {
    this.id = opts.id || randomUUID().slice(0, 8);
    this.contexts = opts.contexts || [];
    this.messages = opts.messages || [];
    this.metadata = opts.metadata || { created: new Date().toISOString(), model: 'default', cost: { total: 0, input: 0, output: 0, calls: 0 } };
    if (!this.metadata.cost) this.metadata.cost = { total: 0, input: 0, output: 0, calls: 0 };
    this.provider = opts.provider || createProvider(opts.role || 'default');
    this.role = opts.role || 'default';
    this._maxToolRounds = opts.maxToolRounds || DEFAULT_MAX_TOOL_ROUNDS;
    this._costCeiling = opts.costCeiling || null; // per-session cost limit (e.g. $0.50 for sub-agents)
    this._deadline = opts.deadline || null; // timestamp (ms) for time-bounded tasks
    this._taskPlan = opts.taskPlan || null; // in-session task plan
    this._outfit = opts.outfit || null; // active outfit (tool restriction + personality)
    this._systemPrompt = null;
    this._graphContext = null; // auto-injected graph memory for current turn
    this._onToolUse = null; // callback: (toolName, args) => void
  }

  // Set a callback to be notified when tools are used
  onToolUse(fn) {
    this._onToolUse = fn;
  }

  _trackUsage(usage) {
    if (!usage) return;
    const cost = calcCost(this.role, usage);
    this.metadata.cost.total = Math.round((this.metadata.cost.total + cost) * 1_000_000) / 1_000_000;
    this.metadata.cost.input += usage.input || 0;
    this.metadata.cost.output += usage.output || 0;
    this.metadata.cost.calls++;
  }

  async init() {
    this._systemPrompt = await buildSystemPrompt(this.contexts, this._outfit);
    await ensureSessionsDir();
    return this;
  }

  _getTools() {
    const providerType = getProviderType(this.role);
    let allTools = providerType === 'anthropic' ? getAnthropicTools() : getOpenAITools();
    if (this._outfit?.tools?.length) {
      allTools = filterToolsByOutfit(allTools, this._outfit.tools);
    }
    return allTools;
  }

  _buildApiMessages() {
    let systemContent = this._systemPrompt;
    // Inject conversation state so the model knows where it is
    const userMsgCount = this.messages.filter(m => m.role === 'user').length;
    const turnLabel = userMsgCount === 0 ? 'New session — no messages yet.' : `${userMsgCount} user message${userMsgCount === 1 ? '' : 's'} in this session.`;
    systemContent += `\n\nSession: ${turnLabel}`;
    // Inject task plan into system prompt so the agent always sees progress
    if (this._taskPlan) {
      const plan = this._taskPlan;
      const done = plan.tasks.filter(t => t.status === 'done').length;
      const total = plan.tasks.length;
      const lines = plan.tasks.map(t => {
        const icon = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : t.status === 'failed' ? '!' : t.status === 'skipped' ? '-' : ' ';
        return `  [${icon}] #${t.id} ${t.text}`;
      }).join('\n');
      systemContent += `\n\n--- Active Task Plan (${done}/${total} done) ---\nGoal: ${plan.goal}\n${lines}`;
    }
    // Inject budget awareness for cost/time-bounded sessions
    if (this._costCeiling || this._deadline) {
      const parts = [];
      if (this._costCeiling) {
        const remaining = Math.max(0, this._costCeiling - this.metadata.cost.total);
        parts.push(`Cost: $${this.metadata.cost.total.toFixed(4)} spent / $${this._costCeiling.toFixed(2)} limit ($${remaining.toFixed(4)} remaining)`);
      }
      if (this._deadline) {
        const remainingMs = Math.max(0, this._deadline - Date.now());
        const remainingMin = Math.ceil(remainingMs / 60000);
        parts.push(`Time: ${remainingMin} minute${remainingMin !== 1 ? 's' : ''} remaining`);
      }
      systemContent += `\n\n--- Budget ---\n${parts.join('\n')}`;
    }
    // Auto-injected graph memory context for this turn
    if (this._graphContext) {
      systemContent += `\n\n--- Recalled from Memory ---\n${this._graphContext}`;
    }
    return [
      { role: 'system', content: systemContent },
      ...this.messages,
    ];
  }

  // Build Anthropic-format tool result message
  _anthropicToolResult(toolCalls, results) {
    return {
      role: 'user',
      content: toolCalls.map((tc, i) => ({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: results[i],
      })),
    };
  }

  // Build OpenAI-format tool result messages
  _openaiToolResults(toolCalls, results) {
    return toolCalls.map((tc, i) => ({
      role: 'tool',
      tool_call_id: tc.id,
      content: results[i],
    }));
  }

  // Build the assistant message that includes tool calls (for message history)
  _assistantToolCallMessage(content, toolCalls, providerType) {
    if (providerType === 'anthropic') {
      const blocks = [];
      if (content) blocks.push({ type: 'text', text: content });
      for (const tc of toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      return { role: 'assistant', content: blocks };
    }
    // OpenAI format
    const msg = { role: 'assistant', content: content || null };
    msg.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
    return msg;
  }

  async send(message) {
    if (!this._systemPrompt) await this.init();

    this.messages.push({ role: 'user', content: message });

    // Auto-inject graph memory — fire-and-forget safe, never blocks on error
    try { this._graphContext = await graphRecall(message); } catch { this._graphContext = null; }

    // Budget check
    const budget = await checkBudget();
    if (!budget.ok) {
      const reply = `Daily budget of $${budget.limit.toFixed(2)} reached ($${budget.spend.toFixed(2)} spent). Override with 'betterbot budget reset' or wait until tomorrow.`;
      this.messages.push({ role: 'assistant', content: reply });
      await this.save();
      return { content: reply };
    }

    const tools = this._getTools();
    const providerType = getProviderType(this.role);
    let rounds = 0;

    while (rounds < this._maxToolRounds) {
      rounds++;
      const apiMessages = this._buildApiMessages();
      const response = await this.provider.chat(apiMessages, { tools });
      this._trackUsage(response.usage);

      // Cost ceiling check (for sub-agents)
      if (this._costCeiling && this.metadata.cost.total >= this._costCeiling) {
        const msg = `[Cost ceiling reached: $${this.metadata.cost.total.toFixed(4)} / $${this._costCeiling.toFixed(2)}]`;
        this.messages.push({ role: 'assistant', content: response.content ? `${response.content}\n\n${msg}` : msg });
        break;
      }

      // Deadline check (for time-bounded tasks)
      if (this._deadline && Date.now() >= this._deadline) {
        const msg = '[Time limit reached — wrapping up]';
        this.messages.push({ role: 'assistant', content: response.content ? `${response.content}\n\n${msg}` : msg });
        break;
      }

      if (!response.tool_calls) {
        // Final text response
        this.messages.push({ role: 'assistant', content: response.content });
        break;
      }

      // Notify listener about tool use
      for (const tc of response.tool_calls) {
        this._onToolUse?.(tc.name, tc.arguments);
      }

      // Execute all tool calls
      const results = await Promise.all(
        response.tool_calls.map(tc => executeTool(tc.name, tc.arguments, this))
      );

      // Add assistant message with tool calls to history
      this.messages.push(this._assistantToolCallMessage(response.content, response.tool_calls, providerType));

      // Add tool results to history
      if (providerType === 'anthropic') {
        this.messages.push(this._anthropicToolResult(response.tool_calls, results));
      } else {
        this.messages.push(...this._openaiToolResults(response.tool_calls, results));
      }
    }

    // Auto-compact if history is getting long
    if (this.messages.length > config.compaction.maxMessagesBeforeCompact) {
      await this.compact();
    }

    await this.save();
    const lastMsg = this.messages.at(-1);
    return { content: typeof lastMsg.content === 'string' ? lastMsg.content : '' };
  }

  async *sendStream(message) {
    if (!this._systemPrompt) await this.init();

    this.messages.push({ role: 'user', content: message });

    // Auto-inject graph memory
    try { this._graphContext = await graphRecall(message); } catch { this._graphContext = null; }

    // Budget check
    const budget = await checkBudget();
    if (!budget.ok) {
      const reply = `Daily budget of $${budget.limit.toFixed(2)} reached ($${budget.spend.toFixed(2)} spent). Override with 'betterbot budget reset' or wait until tomorrow.`;
      this.messages.push({ role: 'assistant', content: reply });
      yield { type: 'text', text: reply };
      await this.save();
      return;
    }

    const tools = this._getTools();
    const providerType = getProviderType(this.role);
    let rounds = 0;

    while (rounds < this._maxToolRounds) {
      rounds++;
      const apiMessages = this._buildApiMessages();

      // Collect stream events
      let textContent = '';
      const toolCalls = [];
      let currentToolIdx = -1;

      for await (const event of this.provider.stream(apiMessages, { tools })) {
        if (event.type === 'text') {
          textContent += event.text;
          yield { type: 'text', text: event.text };
        } else if (event.type === 'tool_use') {
          toolCalls.push(event);
        } else if (event.type === 'usage') {
          this._trackUsage(event.usage);
        }
        // Legacy: plain string from old stream format (Ollama without tools)
        if (typeof event === 'string') {
          textContent += event;
          yield { type: 'text', text: event };
        }
      }

      // Cost ceiling check (for sub-agents)
      if (this._costCeiling && this.metadata.cost.total >= this._costCeiling) {
        const msg = `[Cost ceiling reached: $${this.metadata.cost.total.toFixed(4)} / $${this._costCeiling.toFixed(2)}]`;
        const finalText = textContent ? `${textContent}\n\n${msg}` : msg;
        this.messages.push({ role: 'assistant', content: finalText });
        yield { type: 'text', text: `\n\n${msg}` };
        break;
      }

      // Deadline check (for time-bounded tasks)
      if (this._deadline && Date.now() >= this._deadline) {
        const msg = '[Time limit reached — wrapping up]';
        const finalText = textContent ? `${textContent}\n\n${msg}` : msg;
        this.messages.push({ role: 'assistant', content: finalText });
        yield { type: 'text', text: `\n\n${msg}` };
        break;
      }

      // No tool calls — final response
      if (toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: textContent });
        break;
      }

      // Notify and execute tool calls
      for (const tc of toolCalls) {
        this._onToolUse?.(tc.name, tc.arguments);
        yield { type: 'tool_start', name: tc.name, arguments: tc.arguments };
      }

      const results = await Promise.all(
        toolCalls.map(tc => executeTool(tc.name, tc.arguments, this))
      );

      // Yield tool results for the UI
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_result', name: toolCalls[i].name, result: results[i] };
      }

      // Add to message history
      this.messages.push(this._assistantToolCallMessage(textContent, toolCalls, providerType));

      if (providerType === 'anthropic') {
        this.messages.push(this._anthropicToolResult(toolCalls, results));
      } else {
        this.messages.push(...this._openaiToolResults(toolCalls, results));
      }
    }

    // Auto-compact
    if (this.messages.length > config.compaction.maxMessagesBeforeCompact) {
      await this.compact();
    }

    await this.save();
  }

  async loadContext(name) {
    if (!this.contexts.includes(name)) {
      this.contexts.push(name);
      this._systemPrompt = await buildSystemPrompt(this.contexts, this._outfit);
    }
  }

  async unloadContext(name) {
    this.contexts = this.contexts.filter(c => c !== name);
    this._systemPrompt = await buildSystemPrompt(this.contexts, this._outfit);
  }

  async _rebuildSystemPrompt() {
    this._systemPrompt = await buildSystemPrompt(this.contexts, this._outfit);
  }

  async wearOutfit(name) {
    const outfit = await loadOutfit(name);
    if (!outfit) throw new Error(`Outfit "${name}" not found`);
    // Remove previous outfit's contexts
    if (this._outfit?.contexts?.length) {
      const prev = new Set(this._outfit.contexts);
      this.contexts = this.contexts.filter(c => !prev.has(c));
    }
    this._outfit = outfit;
    // Auto-load outfit's contexts (additive, don't duplicate)
    for (const ctx of outfit.contexts || []) {
      if (!this.contexts.includes(ctx)) this.contexts.push(ctx);
    }
    this._systemPrompt = await buildSystemPrompt(this.contexts, this._outfit);
    return outfit;
  }

  async removeOutfit() {
    if (!this._outfit) return null;
    const removed = this._outfit;
    // Remove outfit's auto-loaded contexts
    const outfitContexts = new Set(this._outfit.contexts || []);
    this.contexts = this.contexts.filter(c => !outfitContexts.has(c));
    this._outfit = null;
    this._systemPrompt = await buildSystemPrompt(this.contexts);
    return removed;
  }

  async compact() {
    const keep = config.compaction.keepRecentMessages;
    if (this.messages.length <= keep) return;

    // Find a safe split point that doesn't break tool_use/tool_result pairs.
    // Walk backward from the target split to find a user message boundary.
    let splitIdx = this.messages.length - keep;
    while (splitIdx > 0 && splitIdx < this.messages.length) {
      const m = this.messages[splitIdx];
      // Safe to split before a user message that isn't a tool_result
      if (m.role === 'user') {
        const isToolResult = Array.isArray(m.content) && m.content.every(b => b.type === 'tool_result');
        if (!isToolResult) break;
      }
      splitIdx++;
    }

    const old = this.messages.slice(0, splitIdx);
    const recent = this.messages.slice(splitIdx);
    if (old.length === 0) return; // nothing safe to compact

    // Archive raw messages before summarizing
    await this._archiveHistory(old);

    // Use cheap model for summarization
    let compactor;
    let compactRole = 'quick';
    try {
      compactor = createProvider('quick');
    } catch {
      compactor = this.provider;
      compactRole = this.role;
    }

    // Flatten messages for summary — tool calls become text descriptions
    const flatMessages = old.map(m => {
      if (m.role === 'tool') return `tool_result: ${m.content?.slice(0, 200)}`;
      if (Array.isArray(m.content)) {
        return m.content.map(b => {
          if (b.type === 'text') return `${m.role}: ${b.text}`;
          if (b.type === 'tool_use') return `${m.role}: [called ${b.name}]`;
          if (b.type === 'tool_result') return `tool_result: ${b.content?.slice(0, 200)}`;
          return '';
        }).join('\n');
      }
      return `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    }).join('\n\n');

    const summaryPrompt = [
      { role: 'system', content: 'Summarize this conversation for a knowledge graph. Include:\n- Topics and projects discussed (by name)\n- People mentioned\n- Decisions made or actions taken\n- Problems encountered and how they were resolved\n- Tools used and their outcomes\nBe specific — use proper nouns, project names, and concrete details. Skip greetings and filler.' },
      { role: 'user', content: flatMessages },
    ];

    let summary;
    try {
      summary = await compactor.chat(summaryPrompt, { maxTokens: 1024 });
    } catch {
      // If the quick model fails (wrong API key, etc), try the main provider
      try {
        summary = await this.provider.chat(summaryPrompt, { maxTokens: 1024 });
      } catch {
        // If even that fails, just truncate without summary
        this.messages = sanitizeOrphans(recent);
        return;
      }
    }

    this.messages = [
      { role: 'assistant', content: `[Conversation summary]\n${summary.content}\n\n[Full history archived in ${this.id}.history.jsonl — use review_session_history to search it]` },
      ...sanitizeOrphans(recent),
    ];

    await appendEntry(`Session ${this.id} compacted: ${old.length} messages → summary`, 'Notes');

    // Fire-and-forget graph extraction — never blocks the agent
    extractToGraph(this.id, summary.content, {
      timestamp: new Date().toISOString(),
      cost: this.metadata.cost.total,
      messageCount: old.length,
    }).catch(() => {});
  }

  async _archiveHistory(messages) {
    try {
      const { appendFile } = await import('node:fs/promises');
      await ensureSessionsDir();
      const historyPath = join(config.sessionsDir, `${this.id}.history.jsonl`);
      const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
      await appendFile(historyPath, lines, 'utf-8');
    } catch {
      // Non-fatal — don't break compaction if archiving fails
    }
  }

  async save() {
    await ensureSessionsDir();
    const path = sessionPath(this.id);
    const data = {
      id: this.id,
      contexts: this.contexts,
      messages: this.messages,
      metadata: { ...this.metadata, updated: new Date().toISOString() },
    };
    // Persist task plan so "continue" works across sessions
    if (this._taskPlan) data.taskPlan = this._taskPlan;
    if (this._outfit) data.outfit = this._outfit;
    await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
  }

  static async resume(id) {
    const path = sessionPath(id);
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    const session = new Session({
      id: data.id,
      contexts: data.contexts,
      messages: data.messages,
      metadata: data.metadata,
      taskPlan: data.taskPlan || null,
      outfit: data.outfit || null,
    });
    await session.init();
    return session;
  }

  static async list() {
    await ensureSessionsDir();
    const dir = config.sessionsDir;
    const files = await readdir(dir);
    const sessions = [];

    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8');
        const data = JSON.parse(raw);
        sessions.push({
          id: data.id,
          contexts: data.contexts,
          messageCount: data.messages.length,
          created: data.metadata.created,
          updated: data.metadata.updated,
          lastMessage: getLastTextMessage(data.messages),
        });
      } catch { /* skip corrupt files */ }
    }

    return sessions.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  }

  static async latest() {
    const sessions = await Session.list();
    if (sessions.length === 0) return null;
    return Session.resume(sessions[0].id);
  }
}

function getLastTextMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.content === 'string' && m.content.trim()) {
      return m.content.slice(0, 80);
    }
  }
  return '';
}

// Remove orphan tool messages from compacted history.
// Ensures tool_use/tool_result pairs are always kept or removed together
// for both Anthropic format (tool_result in user messages) and OpenAI format (role: 'tool').
function sanitizeOrphans(messages) {
  // Pass 1: collect all tool_use IDs present in assistant messages
  const toolUseIds = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
      }
    }
    // OpenAI format: tool_calls on assistant messages
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id) toolUseIds.add(tc.id);
      }
    }
  }

  // Pass 2: filter messages, ensuring paired tool_use/tool_result integrity
  return messages.filter((m) => {
    // OpenAI format: role: 'tool' — keep only if matching tool_use exists
    if (m.role === 'tool') {
      return m.tool_call_id && toolUseIds.has(m.tool_call_id);
    }

    // Anthropic format: user message with tool_result blocks
    if (m.role === 'user' && Array.isArray(m.content)) {
      const isToolResultOnly = m.content.every(b => b.type === 'tool_result');
      if (isToolResultOnly) {
        // Keep only if ALL referenced tool_use IDs exist
        return m.content.every(b => b.tool_use_id && toolUseIds.has(b.tool_use_id));
      }
    }

    if (m.role === 'user') return true;

    if (m.role === 'assistant') {
      // Keep if it has text content
      if (typeof m.content === 'string' && m.content.trim()) return true;
      if (Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text?.trim())) return true;
      // Keep if it has tool_use blocks (the results check above handles the other side)
      if (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use')) return true;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
      return false;
    }

    return false;
  });
}

function sessionPath(id) {
  return join(config.sessionsDir, `${id}.json`);
}

async function ensureSessionsDir() {
  if (!existsSync(config.sessionsDir)) {
    await mkdir(config.sessionsDir, { recursive: true });
  }
}
