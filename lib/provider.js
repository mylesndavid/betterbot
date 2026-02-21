import { getCredential } from './credentials.js';
import { trackUsage } from './cost-tracker.js';
import config from '../config.js';

// Base provider interface
class Provider {
  constructor(opts = {}) {
    this.model = opts.model;
  }

  // Returns: { content, tool_calls, stop_reason, usage }
  // tool_calls: [{ id, name, arguments }] or null
  async chat(messages, opts = {}) {
    throw new Error('chat() not implemented');
  }

  // Yields: { type: 'text', text } or { type: 'tool_use', id, name, arguments }
  async *stream(messages, opts = {}) {
    throw new Error('stream() not implemented');
  }
}

// Anthropic (Claude) provider
class ClaudeProvider extends Provider {
  constructor(opts) {
    super(opts);
    this.apiKey = opts.apiKey;
  }

  async chat(messages, opts = {}) {
    const apiKey = this.apiKey || await getCredential('anthropic_api_key');
    if (!apiKey) throw new Error('No Anthropic API key. Run: claw creds set anthropic_api_key');

    const { system, cleaned } = extractSystem(messages);

    const body = {
      model: this.model,
      max_tokens: opts.maxTokens || 4096,
      messages: cleaned,
    };
    if (system) body.system = system;
    if (opts.tools?.length) body.tools = opts.tools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();

    // Parse content blocks — can be text and/or tool_use
    let textContent = '';
    const toolCalls = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      content: textContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      stop_reason: data.stop_reason, // 'end_turn', 'tool_use', etc.
      usage: {
        input: data.usage?.input_tokens || 0,
        output: data.usage?.output_tokens || 0,
      },
    };
  }

  async *stream(messages, opts = {}) {
    const apiKey = this.apiKey || await getCredential('anthropic_api_key');
    if (!apiKey) throw new Error('No Anthropic API key. Run: claw creds set anthropic_api_key');

    const { system, cleaned } = extractSystem(messages);

    const body = {
      model: this.model,
      max_tokens: opts.maxTokens || 4096,
      messages: cleaned,
      stream: true,
    };
    if (system) body.system = system;
    if (opts.tools?.length) body.tools = opts.tools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    yield* parseAnthropicStream(res.body);
  }
}

// Ollama provider - local models (no tool support)
class OllamaProvider extends Provider {
  constructor(opts) {
    super(opts);
    this.baseUrl = opts.baseUrl || 'http://localhost:11434';
  }

  async chat(messages, opts = {}) {
    const body = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
    };
    // Ollama supports tools for some models
    if (opts.tools?.length) {
      body.tools = opts.tools.map(t => ({
        type: 'function',
        function: { name: t.name || t.function?.name, description: t.description || t.function?.description, parameters: t.input_schema || t.function?.parameters || t.parameters },
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama error ${res.status}: ${err}`);
    }

    const data = await res.json();

    const toolCalls = (data.message?.tool_calls || []).map((tc, i) => ({
      id: `ollama_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: data.message?.content || '',
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        input: data.prompt_eval_count || 0,
        output: data.eval_count || 0,
      },
    };
  }

  async *stream(messages, opts = {}) {
    // If tools are provided, fall back to non-streaming (Ollama streaming + tools is unreliable)
    if (opts.tools?.length) {
      const result = await this.chat(messages, opts);
      if (result.content) yield { type: 'text', text: result.content };
      if (result.tool_calls) {
        for (const tc of result.tool_calls) {
          yield { type: 'tool_use', id: tc.id, name: tc.name, arguments: tc.arguments };
        }
      }
      return;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama error ${res.status}: ${err}`);
    }

    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const data = JSON.parse(line);
          if (data.message?.content) yield { type: 'text', text: data.message.content };
        } catch { /* skip malformed */ }
      }
    }
  }
}

// Generic OpenAI-compatible provider (works with OpenAI, Groq, Together, OpenRouter, etc.)
class OpenAIProvider extends Provider {
  constructor(opts) {
    super(opts);
    this.baseUrl = opts.baseUrl || 'https://api.openai.com/v1';
    this.credentialName = opts.credentialName || 'openai_api_key';
    this.apiKey = opts.apiKey;
  }

  async chat(messages, opts = {}) {
    const apiKey = this.apiKey || await getCredential(this.credentialName);
    if (!apiKey) throw new Error(`No API key. Run: claw creds set ${this.credentialName}`);

    const body = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens || 4096,
    };
    if (opts.tools?.length) body.tools = opts.tools;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI-compatible API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message || {};

    const toolCalls = (msg.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
    }));

    return {
      content: msg.content || '',
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      stop_reason: choice?.finish_reason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
      },
    };
  }

  async *stream(messages, opts = {}) {
    const apiKey = this.apiKey || await getCredential(this.credentialName);
    if (!apiKey) throw new Error(`No API key. Run: claw creds set ${this.credentialName}`);

    const body = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens || 4096,
      stream: true,
    };
    if (opts.tools?.length) body.tools = opts.tools;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI-compatible API error ${res.status}: ${err}`);
    }

    yield* parseOpenAIStream(res.body);
  }
}

// --- Helpers ---

function extractSystem(messages) {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  const cleaned = messages.filter(m => m.role !== 'system');
  return { system: system || undefined, cleaned };
}

// Parse Anthropic SSE stream — yields { type: 'text', text } or { type: 'tool_use', ... }
async function* parseAnthropicStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolUse = null;
  let toolInputJson = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;

      try {
        const event = JSON.parse(data);

        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
            };
            toolInputJson = '';
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text', text: event.delta.text };
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            toolInputJson += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            let args = {};
            try { args = JSON.parse(toolInputJson); } catch { /* empty args */ }
            yield {
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              arguments: args,
            };
            currentToolUse = null;
            toolInputJson = '';
          }
        }
      } catch { /* skip malformed */ }
    }
  }
}

// Parse OpenAI SSE stream — yields { type: 'text', text } or { type: 'tool_use', ... }
async function* parseOpenAIStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  // Track tool calls being built across deltas
  const toolCallsInProgress = new Map(); // index -> { id, name, arguments_str }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        // Flush any pending tool calls
        for (const tc of toolCallsInProgress.values()) {
          let args = {};
          try { args = JSON.parse(tc.arguments_str); } catch { /* empty */ }
          yield { type: 'tool_use', id: tc.id, name: tc.name, arguments: args };
        }
        return;
      }

      try {
        const event = JSON.parse(data);
        const delta = event.choices?.[0]?.delta;
        const finishReason = event.choices?.[0]?.finish_reason;

        if (delta?.content) {
          yield { type: 'text', text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsInProgress.has(idx)) {
              toolCallsInProgress.set(idx, {
                id: tc.id || `call_${idx}`,
                name: tc.function?.name || '',
                arguments_str: '',
              });
            }
            const entry = toolCallsInProgress.get(idx);
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments_str += tc.function.arguments;
          }
        }

        // If finish reason is tool_calls or stop, flush
        if (finishReason === 'tool_calls' || finishReason === 'stop') {
          for (const tc of toolCallsInProgress.values()) {
            let args = {};
            try { args = JSON.parse(tc.arguments_str); } catch { /* empty */ }
            yield { type: 'tool_use', id: tc.id, name: tc.name, arguments: args };
          }
          toolCallsInProgress.clear();
        }
      } catch { /* skip */ }
    }
  }
}

// --- Factory ---

const providers = {
  anthropic: (opts) => new ClaudeProvider(opts),
  ollama: (opts) => new OllamaProvider(opts),
  openai: (opts) => new OpenAIProvider(opts),
  openrouter: (opts) => new OpenAIProvider({
    ...opts,
    baseUrl: 'https://openrouter.ai/api/v1',
    credentialName: 'openrouter_api_key',
  }),
  together: (opts) => new OpenAIProvider({
    ...opts,
    baseUrl: 'https://api.together.xyz/v1',
    credentialName: 'together_api_key',
  }),
  groq: (opts) => new OpenAIProvider({
    ...opts,
    baseUrl: 'https://api.groq.com/openai/v1',
    credentialName: 'groq_api_key',
  }),
  generic: (opts) => new OpenAIProvider(opts),
};

// Wrap a provider to automatically track usage after chat() calls
function withTracking(provider, role) {
  const origChat = provider.chat.bind(provider);
  provider.chat = async function(messages, opts) {
    const result = await origChat(messages, opts);
    if (result.usage) {
      trackUsage(role, result.usage).catch(() => {});
    }
    return result;
  };
  provider._role = role;
  return provider;
}

export function createProvider(role = 'default') {
  let spec = config.models[role];

  // If the requested role doesn't exist or its provider has no credential configured,
  // fall back to the default model. This prevents crashes when e.g. quick=anthropic
  // but the user only has an OpenRouter key.
  if (!spec) {
    if (role !== 'default') {
      spec = config.models.default;
    }
    if (!spec) throw new Error(`Unknown model role: ${role}`);
  }

  const factory = providers[spec.provider];
  if (!factory) {
    // Fall back to default provider if this provider is unknown
    const defaultSpec = config.models.default;
    if (defaultSpec && providers[defaultSpec.provider]) {
      return withTracking(providers[defaultSpec.provider]({ model: defaultSpec.model, ...defaultSpec }), role);
    }
    throw new Error(`Unknown provider: ${spec.provider}`);
  }
  return withTracking(factory({ model: spec.model, ...spec }), role);
}

export function getProviderForRole(role) {
  return createProvider(role);
}

// Detect provider type for tool format
export function getProviderType(role = 'default') {
  const spec = config.models[role];
  return spec?.provider || 'unknown';
}

export { Provider, ClaudeProvider, OllamaProvider, OpenAIProvider };
