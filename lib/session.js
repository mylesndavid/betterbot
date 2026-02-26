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
    // Track the latest input token count — this is the actual context size sent to the API
    this._lastInputTokens = usage.input || 0;
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
      ...validateMessages(this.messages),
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
      let apiMessages = this._buildApiMessages();
      let response;
      try {
        response = await this.provider.chat(apiMessages, { tools });
      } catch (err) {
        // Auto-recover from message format errors (orphaned tool results, etc.)
        if (err.message?.includes('400') || err.message?.includes('invalid_request')) {
          const { repaired, removed } = repairMessages(this.messages);
          if (removed.length > 0) {
            this.messages = repaired;
            this.messages.push({ role: 'assistant', content: `[Auto-repair: removed ${removed.length} malformed message(s) — ${removed.join('; ')}. Continuing.]` });
            apiMessages = this._buildApiMessages();
            response = await this.provider.chat(apiMessages, { tools });
          } else {
            throw err; // not a format issue we can fix
          }
        } else {
          throw err;
        }
      }
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

    // Auto-compact based on user turn count OR estimated token usage
    if (this._needsCompaction()) {
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
      let apiMessages = this._buildApiMessages();

      // Collect stream events
      let textContent = '';
      const toolCalls = [];
      let currentToolIdx = -1;
      let streamSource;

      try {
        streamSource = this.provider.stream(apiMessages, { tools });
        // Trigger the initial request by peeking at the first event
        const firstChunk = await streamSource.next();
        // Re-wrap into a generator that yields the first chunk then the rest
        const self = this;
        const originalStream = streamSource;
        streamSource = (async function*() {
          if (!firstChunk.done) yield firstChunk.value;
          yield* originalStream;
        })();
      } catch (err) {
        if (err.message?.includes('400') || err.message?.includes('invalid_request')) {
          const { repaired, removed } = repairMessages(this.messages);
          if (removed.length > 0) {
            this.messages = repaired;
            const note = `[Auto-repair: removed ${removed.length} malformed message(s) — ${removed.join('; ')}. Continuing.]`;
            this.messages.push({ role: 'assistant', content: note });
            yield { type: 'text', text: note + '\n\n' };
            apiMessages = this._buildApiMessages();
            streamSource = this.provider.stream(apiMessages, { tools });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      for await (const event of streamSource) {
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

  // Count real user messages (not tool results) in the message history
  _countUserTurns() {
    let count = 0;
    for (const m of this.messages) {
      if (m.role === 'user') {
        const isToolResult = Array.isArray(m.content) && m.content.every(b => b.type === 'tool_result');
        if (!isToolResult) count++;
      }
    }
    return count;
  }

  _needsCompaction() {
    const maxTokens = config.compaction.maxTokens || 100_000;
    // Use actual input token count from the last API call (real context size)
    if (this._lastInputTokens && this._lastInputTokens > maxTokens) return true;
    // Also check user turn count as a fallback
    if (this._countUserTurns() > config.compaction.maxMessagesBeforeCompact) return true;
    return false;
  }

  async compact() {
    // Count actual user/assistant conversation turns, not raw message objects.
    // A single tool-use round creates 2-3 messages, so raw count is misleading.
    const keepTurns = config.compaction.keepRecentMessages; // treat as turn count
    if (this.messages.length <= keepTurns) return;

    // Walk backward from the end, counting user messages as "turns".
    // Keep at least `keepTurns` user messages (and all their associated tool messages).
    let turnsFound = 0;
    let splitIdx = this.messages.length;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user') {
        const isToolResult = Array.isArray(m.content) && m.content.every(b => b.type === 'tool_result');
        if (!isToolResult) {
          turnsFound++;
          if (turnsFound >= keepTurns) {
            splitIdx = i;
            break;
          }
        }
      }
    }

    // If we couldn't find enough turns, nothing safe to compact
    if (splitIdx <= 0) return;

    const old = this.messages.slice(0, splitIdx);
    const recent = this.messages.slice(splitIdx);
    if (old.length === 0) return;

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
          if (b.type === 'tool_use') return `${m.role}: [called ${b.name}(${JSON.stringify(b.input).slice(0, 100)})]`;
          if (b.type === 'tool_result') return `tool_result: ${b.content?.slice(0, 200)}`;
          return '';
        }).join('\n');
      }
      return `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    }).join('\n\n');

    const summaryPrompt = [
      { role: 'system', content: `You are summarizing the OLDER part of an ongoing conversation so the assistant can maintain context. The most recent messages are NOT included here — they are kept verbatim.

Write a factual summary of what happened in this conversation. Include:
- What the user asked for or was discussing
- What actions were actually taken (tools called, files modified, commands run)
- What the outcomes were (successes, errors, pending items)
- Any decisions made or preferences expressed by the user

CRITICAL RULES:
- Only describe actions that are explicitly shown in the tool calls and results below. Do NOT infer or assume actions that aren't in the transcript.
- If a tool call failed or returned an error, say so. Do not describe it as successful.
- Use phrases like "attempted to", "called X tool", "the result showed" — not "verified", "confirmed", "completed" unless the tool result explicitly shows success.
- Be specific with file paths, command outputs, and error messages.` },
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
      { role: 'assistant', content: `[Conversation summary — older messages were compacted]\n${summary.content}\n\n[IMPORTANT: This summary may be incomplete. The full raw transcript is archived in ${this.id}.history.jsonl. Use the review_session_history tool with session_id="${this.id}" to search or browse the original messages. Use a query string to search for specific topics.]` },
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

// Pre-flight validator: silently fix message array before sending to API.
// Called on every turn via _buildApiMessages(). Lightweight — only fixes known issues.
function validateMessages(messages) {
  if (!messages.length) return messages;

  // Build set of all tool_use IDs in the conversation
  const toolUseIds = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc.id) toolUseIds.add(tc.id);
    }
  }

  // Build set of all tool_result IDs
  const toolResultIds = new Set();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) toolResultIds.add(m.tool_call_id);
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result' && b.tool_use_id) toolResultIds.add(b.tool_use_id);
    }
  }

  return messages.filter((m) => {
    // Drop orphaned tool results (no matching tool_use)
    if (m.role === 'tool') return m.tool_call_id && toolUseIds.has(m.tool_call_id);
    if (m.role === 'user' && Array.isArray(m.content) && m.content.every(b => b.type === 'tool_result')) {
      return m.content.every(b => b.tool_use_id && toolUseIds.has(b.tool_use_id));
    }
    // Drop assistant tool_use messages whose results are missing (would cause API to expect results)
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use')) {
      const uses = m.content.filter(b => b.type === 'tool_use');
      const allHaveResults = uses.every(b => toolResultIds.has(b.id));
      if (!allHaveResults) {
        // If there's also text, strip tool_use blocks and keep text
        const textBlocks = m.content.filter(b => b.type === 'text' && b.text?.trim());
        if (textBlocks.length > 0) {
          m.content = textBlocks;
          return true;
        }
        return false;
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const allHaveResults = m.tool_calls.every(tc => toolResultIds.has(tc.id));
      if (!allHaveResults) {
        // Strip tool_calls, keep text if present
        if (m.content && typeof m.content === 'string' && m.content.trim()) {
          delete m.tool_calls;
          return true;
        }
        return false;
      }
    }
    // Drop empty assistant messages
    if (m.role === 'assistant') {
      if (typeof m.content === 'string') return m.content.trim().length > 0;
      if (Array.isArray(m.content)) return m.content.length > 0;
      if (!m.content && !m.tool_calls) return false;
    }
    return true;
  });
}

// Aggressive repair for when the API has already rejected messages.
// Returns { repaired: messages[], removed: string[] } describing what was cleaned.
function repairMessages(messages) {
  const removed = [];
  const before = messages.length;

  // Run validateMessages first
  let repaired = validateMessages([...messages]);
  if (repaired.length < before) {
    removed.push(`${before - repaired.length} orphaned tool message(s)`);
  }

  // Ensure conversation doesn't start with assistant (Anthropic requires user-first)
  while (repaired.length > 0 && repaired[0].role === 'assistant') {
    repaired.shift();
    removed.push('leading assistant message');
  }

  // Ensure no consecutive same-role messages (merge or drop)
  const merged = [];
  for (const m of repaired) {
    const prev = merged.at(-1);
    if (prev && prev.role === m.role && m.role === 'assistant' && typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content += '\n\n' + m.content;
      removed.push('duplicate consecutive assistant message (merged)');
    } else {
      merged.push(m);
    }
  }
  repaired = merged;

  // Final: ensure last message isn't an orphaned tool result
  while (repaired.length > 0) {
    const last = repaired.at(-1);
    if (last.role === 'tool' || (last.role === 'user' && Array.isArray(last.content) && last.content.every(b => b.type === 'tool_result'))) {
      repaired.pop();
      removed.push('trailing orphaned tool result');
    } else {
      break;
    }
  }

  return { repaired, removed };
}

function sessionPath(id) {
  return join(config.sessionsDir, `${id}.json`);
}

async function ensureSessionsDir() {
  if (!existsSync(config.sessionsDir)) {
    await mkdir(config.sessionsDir, { recursive: true });
  }
}
