import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCredential } from './credentials.js';
import { Session } from './session.js';
import config from '../config.js';

const SESSIONS_FILE = join(config.dataDir, 'telegram-sessions.json');

// ──────────────────────────────────────────────────────────
// Channel senders — each knows how to push a message
// ──────────────────────────────────────────────────────────

const senders = {
  async telegram(message) {
    const token = await getCredential('telegram_bot_token');
    const chatId = await getCredential('telegram_chat_id');
    if (!token || !chatId) throw new Error('Telegram not configured. Run: betterbot setup telegram');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    return chatId;
  },

  async slack(message) {
    const token = await getCredential('slack_bot_token');
    const channel = config.slack?.defaultChannel;
    if (!token || !channel) throw new Error('Slack notifications not configured. Set slack_bot_token credential and slack.defaultChannel in config.');
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text: message }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return channel;
  },
};

// ──────────────────────────────────────────────────────────
// Context handoff — inject a note into the channel's session
// so if the user replies, the agent knows what happened
// ──────────────────────────────────────────────────────────

const sessionResolvers = {
  async telegram() {
    // Find the session for the primary chat ID
    const chatId = await getCredential('telegram_chat_id');
    if (!chatId) return null;
    try {
      const map = JSON.parse(await readFile(SESSIONS_FILE, 'utf-8'));
      const sessionId = map[chatId];
      if (!sessionId) return null;
      return await Session.resume(sessionId);
    } catch {
      return null;
    }
  },
};

async function injectContext(channel, message, opts = {}) {
  const resolver = sessionResolvers[channel];
  if (!resolver) return;

  const session = await resolver();
  if (!session) return;

  // Inject as a pair: assistant notification + implicit user awareness
  // This way if the user replies, the agent has context
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  const contextNote = opts.context
    ? `\n[Context: ${opts.context}]`
    : '';

  session.messages.push({
    role: 'assistant',
    content: `[Notification sent at ${timeStr}]${contextNote}\n${message}`,
  });

  await session.save();
}

// ──────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────

/**
 * Send a notification to the user via their configured channel.
 * Also injects context into the channel session for continuity.
 *
 * @param {string} message - The notification text
 * @param {object} opts - Options
 * @param {string} opts.channel - Override channel (defaults to config.notifyChannel)
 * @returns {string} Result message
 */
export async function notifyUser(message, opts = {}) {
  const channel = opts.channel || config.notifyChannel;

  const sender = senders[channel];
  if (!sender) throw new Error(`Unknown notify channel: ${channel}. Supported: ${Object.keys(senders).join(', ')}`);

  // Send file if provided and channel supports it
  if (opts.filePath && channel === 'telegram') {
    const { sendFile } = await import('./channels/telegram.js');
    const token = await getCredential('telegram_bot_token');
    const chatId = await getCredential('telegram_chat_id');
    if (!token || !chatId) throw new Error('Telegram not configured for file sending.');
    await sendFile(token, chatId, opts.filePath, { caption: message });
  } else {
    // Send the text notification
    await sender(message);
  }

  // Inject context into the channel's session for reply continuity
  try {
    await injectContext(channel, message, opts);
  } catch (err) {
    // Non-critical — notification already sent
    console.error(`notify: context handoff failed: ${err.message}`);
  }

  return opts.filePath ? `File sent via ${channel}.` : `Notification sent via ${channel}.`;
}
