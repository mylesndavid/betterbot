// Browser sub-agent: thin wrapper bridging better-browse with betterbot's provider system

import { browseWeb } from 'better-browse/agent';
import { createProvider } from './provider.js';

/**
 * Run a browser task with a text-based sub-agent using ARIA snapshots.
 * @param {string} url - Starting URL
 * @param {string} task - What to do
 * @param {object} opts - Browser options (headless, useProfile, record, etc.)
 * @returns {string} Result summary
 */
export async function runBrowserTask(url, task, opts = {}) {
  let provider;
  try {
    provider = createProvider('browser');
  } catch {
    provider = createProvider('quick');
  }

  const result = await browseWeb(url, task, {
    ...opts,
    chat: async (messages, chatOpts) => provider.chat(messages, chatOpts),
  });

  // Format return to match existing tool expectations (string)
  const recording = result.recording?.video
    ? `\n\n[Recording saved: ${result.recording.video}]`
    : '';
  const cost = result.usage
    ? `\n\n--- Browser Session Cost ---\n${result.usage.modelCalls} model calls | ${result.usage.inputTokens?.toLocaleString() || '?'} input + ${result.usage.outputTokens?.toLocaleString() || '?'} output tokens | ~$${((result.usage.inputTokens / 1_000_000) * 0.10 + (result.usage.outputTokens / 1_000_000) * 0.40).toFixed(4)}`
    : '';
  return result.result + recording + cost;
}
