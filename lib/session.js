import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from './identity.js';
import { createProvider, getProviderType } from './provider.js';
import { appendEntry } from './journal.js';
import { getAnthropicTools, getOpenAITools, executeTool } from './tools.js';
import { checkBudget, calcCost } from './cost-tracker.js';
import config from '../config.js';

const MAX_TOOL_ROUNDS = 15; // Safety limit on tool-use loops

export class Session {
  constructor(opts = {}) {
    this.id = opts.id || randomUUID().slice(0, 8);
    this.contexts = opts.contexts || [];
    this.messages = opts.messages || [];
    this.metadata = opts.metadata || { created: new Date().toISOString(), model: 'default', cost: { total: 0, input: 0, output: 0, calls: 0 } };
    if (!this.metadata.cost) this.metadata.cost = { total: 0, input: 0, output: 0, calls: 0 };
    this.provider = opts.provider || createProvider(opts.role || 'default');
    this.role = opts.role || 'default';
    this._systemPrompt = null;
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
    this._systemPrompt = await buildSystemPrompt(this.contexts);
    await ensureSessionsDir();
    return this;
  }

  _getTools() {
    const providerType = getProviderType(this.role);
    if (providerType === 'anthropic') return getAnthropicTools();
    return getOpenAITools(); // OpenAI format works for openai, openrouter, together, groq
  }

  _buildApiMessages() {
    return [
      { role: 'system', content: this._systemPrompt },
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

    // Budget check
    const budget = await checkBudget();
    if (!budget.ok) {
      const reply = `Daily budget of $${budget.limit.toFixed(2)} reached ($${budget.spend.toFixed(2)} spent). Override with 'claw budget reset' or wait until tomorrow.`;
      this.messages.push({ role: 'assistant', content: reply });
      await this.save();
      return { content: reply };
    }

    const tools = this._getTools();
    const providerType = getProviderType(this.role);
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const apiMessages = this._buildApiMessages();
      const response = await this.provider.chat(apiMessages, { tools });
      this._trackUsage(response.usage);

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

    // Budget check
    const budget = await checkBudget();
    if (!budget.ok) {
      const reply = `Daily budget of $${budget.limit.toFixed(2)} reached ($${budget.spend.toFixed(2)} spent). Override with 'claw budget reset' or wait until tomorrow.`;
      this.messages.push({ role: 'assistant', content: reply });
      yield { type: 'text', text: reply };
      await this.save();
      return;
    }

    const tools = this._getTools();
    const providerType = getProviderType(this.role);
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
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
      this._systemPrompt = await buildSystemPrompt(this.contexts);
    }
  }

  async unloadContext(name) {
    this.contexts = this.contexts.filter(c => c !== name);
    this._systemPrompt = await buildSystemPrompt(this.contexts);
  }

  async compact() {
    const keep = config.compaction.keepRecentMessages;
    if (this.messages.length <= keep) return;

    const old = this.messages.slice(0, -keep);
    const recent = this.messages.slice(-keep);

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
      { role: 'system', content: 'Summarize this conversation concisely. Preserve key decisions, action items, tool results, and important context. Be brief.' },
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

// Remove orphan tool messages from compacted history
function sanitizeOrphans(messages) {
  return messages.filter((m) => {
    if (m.role === 'user') return true;
    if (m.role === 'assistant') {
      // Keep if it has text content
      if (typeof m.content === 'string' && m.content.trim()) return true;
      if (Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text?.trim())) return true;
      return false;
    }
    // Drop tool results that are orphaned
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
