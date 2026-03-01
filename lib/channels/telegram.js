import { Session } from '../session.js';
import { buildSystemPrompt } from '../identity.js';
import { getCredential } from '../credentials.js';
import { formatBudgetStatus } from '../cost-tracker.js';
import { runDoctorHeadless } from '../doctor.js';
import { listFriends, sendToFriend, sendOwnerMessage } from '../channels/betterfriends.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import config from '../../config.js';

const API_BASE = 'https://api.telegram.org/bot';
const SESSIONS_FILE = join(config.dataDir, 'telegram-sessions.json');
const MAX_MESSAGE_LENGTH = 4096;
const PROMPT_STALE_MS = 5 * 60 * 1000; // 5 minutes
const EDIT_RATE_MS = 1200; // minimum ms between edits

// In-memory session cache: chatId → { session, promptBuiltAt }
const sessionCache = new Map();

// Load chat-to-session mapping
async function loadSessionMap() {
  try {
    const raw = await readFile(SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSessionMap(map) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(map, null, 2));
}

// Telegram API helpers
async function tg(token, method, body = {}) {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function tgUpload(token, method, chatId, fieldName, fileBuffer, filename, extra = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(fieldName, new Blob([fileBuffer]), filename);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) form.append(k, String(v));
  }
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

export async function sendFile(token, chatId, filePath, opts = {}) {
  const buf = await readFile(filePath);
  const filename = filePath.split('/').pop();
  const ext = extname(filePath).toLowerCase();
  const extra = {};
  if (opts.caption) extra.caption = opts.caption;

  if (ext === '.mp4') {
    return tgUpload(token, 'sendVideo', chatId, 'video', buf, filename, extra);
  }
  return tgUpload(token, 'sendDocument', chatId, 'document', buf, filename, extra);
}

async function sendMessage(token, chatId, text, opts = {}) {
  // Chunk if too long
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline near the limit
    let breakAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (breakAt < MAX_MESSAGE_LENGTH / 2) breakAt = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }

  let firstResult = null;
  for (const chunk of chunks) {
    const result = await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: opts.parseMode || undefined,
    });
    if (!firstResult) firstResult = result;
  }
  return firstResult;
}

async function sendTyping(token, chatId) {
  try {
    await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch { /* non-critical */ }
}

// Get or create a session for a Telegram chat, with in-memory caching
async function getSession(chatId, sessionMap) {
  // Check in-memory cache first
  const cached = sessionCache.get(chatId);
  if (cached) {
    // Refresh system prompt if stale
    if (Date.now() - cached.promptBuiltAt > PROMPT_STALE_MS) {
      cached.session._systemPrompt = await buildSystemPrompt(cached.session.contexts);
      cached.promptBuiltAt = Date.now();
    }
    return cached.session;
  }

  // Try to resume from disk
  let session;
  if (sessionMap[chatId]) {
    try {
      session = await Session.resume(sessionMap[chatId]);
    } catch { /* session file gone, create new */ }
  }

  if (!session) {
    session = new Session();
    await session.init();
    sessionMap[chatId] = session.id;
    await saveSessionMap(sessionMap);
  }

  sessionCache.set(chatId, { session, promptBuiltAt: Date.now() });
  return session;
}

// --- Slash commands ---
const COMMANDS = {
  '/new': { desc: 'Start a new session', handler: handleNewSession },
  '/sessions': { desc: 'List recent sessions', handler: handleListSessions },
  '/switch': { desc: 'Switch to a session by ID', handler: handleSwitchSession },
  '/cost': { desc: 'Show today\'s budget usage', handler: handleCost },
  '/doctor': { desc: 'Run diagnostics', handler: handleDoctor },
  '/clear': { desc: 'Clear current session history', handler: handleClear },
  '/compact': { desc: 'Compress session history (frees context)', handler: handleCompact },
  '/status': { desc: 'Current session info', handler: handleStatus },
  '/version': { desc: 'Show BetterBot version & commit', handler: handleVersion },
  '/bf': { desc: 'BetterFriends — chat with friend bots', handler: handleBf },
  '/help': { desc: 'Show available commands', handler: handleHelp },
};

async function handleHelp(token, chatId) {
  const lines = Object.entries(COMMANDS).map(([cmd, { desc }]) => `${cmd} — ${desc}`);
  await sendMessage(token, chatId, lines.join('\n'));
}

async function handleNewSession(token, chatId, _args, sessionMap) {
  const session = new Session();
  await session.init();
  sessionMap[String(chatId)] = session.id;
  await saveSessionMap(sessionMap);
  sessionCache.set(String(chatId), { session, promptBuiltAt: Date.now() });
  await sendMessage(token, chatId, `New session started: ${session.id}`);
}

async function handleListSessions(token, chatId) {
  const sessions = await Session.list();
  if (sessions.length === 0) {
    await sendMessage(token, chatId, 'No sessions found.');
    return;
  }
  const lines = sessions.slice(0, 10).map((s, i) => {
    const age = s.updated ? timeSince(new Date(s.updated)) : '?';
    const preview = s.lastMessage || '(empty)';
    return `${i + 1}. \`${s.id}\` (${age} ago, ${s.messageCount} msgs)\n   ${preview}`;
  });
  await sendMessage(token, chatId, lines.join('\n\n'));
}

async function handleSwitchSession(token, chatId, args, sessionMap) {
  const targetId = args.trim();
  if (!targetId) {
    await sendMessage(token, chatId, 'Usage: /switch <session-id>');
    return;
  }
  try {
    const session = await Session.resume(targetId);
    sessionMap[String(chatId)] = session.id;
    await saveSessionMap(sessionMap);
    sessionCache.set(String(chatId), { session, promptBuiltAt: Date.now() });
    await sendMessage(token, chatId, `Switched to session ${session.id} (${session.messages.length} messages)`);
  } catch {
    await sendMessage(token, chatId, `Session "${targetId}" not found.`);
  }
}

async function handleCost(token, chatId) {
  const status = await formatBudgetStatus();
  await sendMessage(token, chatId, status);
}

async function handleDoctor(token, chatId) {
  const results = await runDoctorHeadless();
  const lines = [];
  if (results.fixed.length) lines.push('Fixed:\n' + results.fixed.map(f => `  ✓ ${f}`).join('\n'));
  if (results.warnings.length) lines.push('Warnings:\n' + results.warnings.map(w => `  ⚠ ${w}`).join('\n'));
  if (results.ok.length) lines.push('OK:\n' + results.ok.map(o => `  ● ${o}`).join('\n'));
  await sendMessage(token, chatId, lines.join('\n\n') || 'All good — no issues found.');
}

async function handleClear(token, chatId, _args, sessionMap) {
  const session = new Session();
  await session.init();
  sessionMap[String(chatId)] = session.id;
  await saveSessionMap(sessionMap);
  sessionCache.set(String(chatId), { session, promptBuiltAt: Date.now() });
  await sendMessage(token, chatId, 'Chat cleared — fresh session started.');
}

async function handleCompact(token, chatId, _args, sessionMap) {
  const session = await getSession(String(chatId), sessionMap);
  const before = session.messages.length;
  await session.compact();
  await session.save();
  const after = session.messages.length;
  if (before === after) {
    await sendMessage(token, chatId, `Nothing to compact (${before} messages, already minimal).`);
  } else {
    await sendMessage(token, chatId, `Compacted: ${before} → ${after} messages. Context freed up.`);
  }
}

async function handleStatus(token, chatId, _args, sessionMap) {
  const sid = sessionMap[String(chatId)];
  const cached = sessionCache.get(String(chatId));
  const session = cached?.session;
  const lines = [
    `Session: ${sid || 'none'}`,
    `Messages: ${session?.messages?.length || 0}`,
    `Cost: $${(session?.metadata?.cost?.total || 0).toFixed(4)}`,
    `Model: ${session?.role || 'default'}`,
  ];
  if (session?._outfit) lines.push(`Outfit: ${session._outfit.name}`);
  await sendMessage(token, chatId, lines.join('\n'));
}

async function handleVersion(token, chatId) {
  const __tg_dirname = dirname(fileURLToPath(import.meta.url));
  const appRoot = join(__tg_dirname, '../..');
  const lines = [];

  try {
    const pkg = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf-8'));
    lines.push(`Version: ${pkg.version}`);
  } catch {}

  // Find the git repo (same candidate pattern as gateway.js)
  let repoDir = null;
  const candidates = [
    appRoot,
    join(homedir(), 'Development/Repos/betterclaw'),
    join(homedir(), 'Development/Repos/betterbot'),
  ];
  for (const dir of candidates) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
      const remote = execSync('git remote get-url origin', { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
      if (remote.includes('betterbot') || remote.includes('betterclaw')) {
        repoDir = dir;
        break;
      }
    } catch {}
  }

  if (!repoDir) {
    lines.push('Git repo not found.');
    await sendMessage(token, chatId, lines.join('\n'));
    return;
  }

  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const date = execSync('git log -1 --format=%ad --date=short', { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    lines.push(`Commit: ${hash} (${date})`);
    lines.push(`Branch: ${branch}`);

    try {
      execSync('git fetch --quiet', { cwd: repoDir, stdio: 'pipe', timeout: 10000 });
      const behind = parseInt(execSync('git rev-list --count HEAD..@{u}', { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim(), 10) || 0;
      lines.push(behind === 0 ? 'Up to date' : `${behind} commit${behind === 1 ? '' : 's'} behind remote`);
    } catch {
      lines.push('Could not check remote.');
    }
  } catch (err) {
    lines.push(`Git error: ${err.message}`);
  }

  await sendMessage(token, chatId, lines.join('\n'));
}

async function handleBf(token, chatId, args) {
  const trimmed = args.trim();

  // No args → list friends
  if (!trimmed) {
    try {
      const data = await listFriends();
      if (!data.friends?.length) {
        await sendMessage(token, chatId, 'No BetterFriends configured.');
        return;
      }
      const lines = data.friends.map(f => {
        const status = f.status === 'accepted' ? '' : ` (${f.status})`;
        return `${f.handle} — ${f.display_name || 'unnamed'}${status}`;
      });
      await sendMessage(token, chatId, `BetterFriends:\n${lines.join('\n')}\n\nUsage:\n/bf @handle message\n/bf @handle --direct message`);
    } catch (err) {
      await sendMessage(token, chatId, `Error: ${err.message}`);
    }
    return;
  }

  // Parse: @handle [--direct] message
  const match = trimmed.match(/^(@\S+)\s*(.*)/s);
  if (!match) {
    await sendMessage(token, chatId, 'Usage: /bf @handle message\n       /bf @handle --direct message');
    return;
  }

  const handle = match[1];
  let rest = match[2].trim();

  if (!rest) {
    await sendMessage(token, chatId, `Usage: /bf ${handle} your message here`);
    return;
  }

  // --direct: bypass agent, send raw to friend's bot
  if (rest.startsWith('--direct ') || rest === '--direct') {
    const directMsg = rest.replace(/^--direct\s*/, '').trim();
    if (!directMsg) {
      await sendMessage(token, chatId, `Usage: /bf ${handle} --direct your message`);
      return;
    }
    try {
      await sendToFriend(handle, directMsg, 'message', { source: 'human' });
      await sendMessage(token, chatId, `Sent directly to ${handle}: ${directMsg}`);
    } catch (err) {
      await sendMessage(token, chatId, `Failed to send to ${handle}: ${err.message}`);
    }
    return;
  }

  // Normal: route through BetterFriends session
  try {
    await sendMessage(token, chatId, `Sending to ${handle}...`);
    const response = await sendOwnerMessage(handle, rest);
    await sendMessage(token, chatId, `[BF ${handle}] ${response}`);
  } catch (err) {
    await sendMessage(token, chatId, `Error: ${err.message}`);
  }
}

function timeSince(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Download a file from Telegram servers
async function downloadTelegramFile(token, fileId) {
  const fileInfo = await tg(token, 'getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), filePath: fileInfo.file_path };
}

// Save a Telegram file to disk and return the local path
async function saveTelegramFile(token, fileId, filename) {
  const filesDir = join(config.dataDir, 'telegram-files');
  await mkdir(filesDir, { recursive: true });
  const { buffer } = await downloadTelegramFile(token, fileId);
  const safeName = filename.replace(/[/\\]/g, '_');
  const localPath = join(filesDir, `${Date.now()}-${safeName}`);
  await writeFile(localPath, buffer);
  return localPath;
}

// Extract file info from a Telegram message (document, photo, video, voice, audio)
function extractFileInfo(message) {
  if (message.document) {
    return { fileId: message.document.file_id, filename: message.document.file_name || 'document', type: 'document' };
  }
  if (message.photo) {
    // Photos come as array of sizes — pick the largest
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, filename: 'photo.jpg', type: 'photo' };
  }
  if (message.video) {
    return { fileId: message.video.file_id, filename: message.video.file_name || 'video.mp4', type: 'video' };
  }
  if (message.voice) {
    return { fileId: message.voice.file_id, filename: 'voice.ogg', type: 'voice' };
  }
  if (message.audio) {
    return { fileId: message.audio.file_id, filename: message.audio.file_name || 'audio.mp3', type: 'audio' };
  }
  return null;
}

// Handle a single incoming message with streaming edit-in-place
async function handleMessage(token, message, sessionMap, allowedChatIds) {
  const chatId = message.chat.id;
  let text = message.text;

  // Handle file messages — download and inject as text
  if (!text) {
    const fileInfo = extractFileInfo(message);
    if (!fileInfo) return; // Unsupported message type (sticker, etc.)

    // Authorization check (before downloading)
    if (allowedChatIds.length > 0 && !allowedChatIds.includes(String(chatId))) {
      console.log(`Telegram: unauthorized message from chat ${chatId}`);
      await sendMessage(token, chatId, 'Not authorized.');
      return;
    }

    try {
      const localPath = await saveTelegramFile(token, fileInfo.fileId, fileInfo.filename);
      const caption = message.caption ? `\n\nCaption: ${message.caption}` : '';
      text = `[User sent a ${fileInfo.type}: ${fileInfo.filename} — saved to ${localPath}]${caption}`;
      console.log(`Telegram: saved ${fileInfo.type} from chat ${chatId} → ${localPath}`);
    } catch (err) {
      console.error(`Telegram: failed to download file: ${err.message}`);
      await sendMessage(token, chatId, `Failed to download file: ${err.message}`);
      return;
    }
  }

  // Authorization check
  if (allowedChatIds.length > 0 && !allowedChatIds.includes(String(chatId))) {
    console.log(`Telegram: unauthorized message from chat ${chatId}`);
    await sendMessage(token, chatId, 'Not authorized.');
    return;
  }

  // Track last user contact for heartbeat idle awareness
  try {
    const statePath = join(config.dataDir, 'heartbeat-state.json');
    const raw = await readFile(statePath, 'utf-8').catch(() => '{}');
    const hbState = JSON.parse(raw);
    hbState.lastUserContact = new Date().toISOString();
    await writeFile(statePath, JSON.stringify(hbState, null, 2));
  } catch { /* non-critical */ }

  // Handle slash commands
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.split(' ');
    const command = COMMANDS[cmd.toLowerCase().replace(/@.*$/, '')]; // strip @botname suffix
    if (command) {
      try {
        await command.handler(token, chatId, rest.join(' '), sessionMap);
      } catch (err) {
        await sendMessage(token, chatId, `Error: ${err.message}`);
      }
      return;
    }
    // Unknown command — fall through to agent (might be intentional like "/start")
  }

  const session = await getSession(String(chatId), sessionMap);

  // Show typing indicator immediately — delay the placeholder message
  // until we have actual content, so the typing dots stay visible
  await sendTyping(token, chatId);

  let messageId = null;
  let lastSentText = '';
  let lastEditTime = 0;
  let editTimer = null;
  let fullResponse = '';

  // Send or edit the response message
  async function sendOrEdit(text) {
    if (!text || text === lastSentText) return;
    const editText = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n[continued...]'
      : text;
    lastSentText = editText;
    lastEditTime = Date.now();

    if (!messageId) {
      // First chunk — send initial message
      try {
        const msg = await tg(token, 'sendMessage', {
          chat_id: chatId,
          text: editText,
        });
        messageId = msg.message_id;
      } catch (err) {
        console.error(`Telegram: failed to send message: ${err.message}`);
      }
    } else {
      // Subsequent chunks — edit in place
      tg(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: editText,
      }).catch(() => {});
    }
  }

  // Rate-limited update function
  function scheduleEdit(text) {
    const now = Date.now();
    const elapsed = now - lastEditTime;

    if (editTimer) clearTimeout(editTimer);

    if (elapsed >= EDIT_RATE_MS) {
      sendOrEdit(text);
    } else {
      editTimer = setTimeout(() => sendOrEdit(text), EDIT_RATE_MS - elapsed);
    }
  }

  // Keep typing indicator alive until first message is sent
  const typingInterval = setInterval(() => {
    if (!messageId) sendTyping(token, chatId);
  }, 4000);

  try {
    for await (const event of session.sendStream(text)) {
      if (event.type === 'text') {
        fullResponse += event.text;
        scheduleEdit(fullResponse.trim());
      }
    }

    // Clear any pending edit timer
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }

    // Final message with Markdown formatting
    if (fullResponse.trim()) {
      const finalText = fullResponse.trim();

      if (!messageId || finalText.length > MAX_MESSAGE_LENGTH) {
        // No message sent yet, or too long — send fresh (as chunks if needed)
        if (messageId) {
          try { await tg(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }); } catch {}
        }
        try {
          await sendMessage(token, chatId, finalText, { parseMode: 'Markdown' });
        } catch {
          await sendMessage(token, chatId, finalText);
        }
      } else {
        // Edit existing message with Markdown
        try {
          await tg(token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: finalText,
            parse_mode: 'Markdown',
          });
        } catch {
          try {
            await tg(token, 'editMessageText', {
              chat_id: chatId,
              message_id: messageId,
              text: finalText,
            });
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error(`Telegram: error handling message: ${err.message}`);
    if (messageId) {
      try {
        await tg(token, 'editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: `Error: ${err.message}`,
        });
      } catch {
        await sendMessage(token, chatId, `Error: ${err.message}`);
      }
    } else {
      await sendMessage(token, chatId, `Error: ${err.message}`);
    }
  } finally {
    clearInterval(typingInterval);
    if (editTimer) clearTimeout(editTimer);
  }
}

export async function startTelegramBot() {
  const token = await getCredential('telegram_bot_token');
  if (!token) throw new Error('telegram_bot_token not configured (run: betterbot creds set telegram_bot_token <token>)');

  // Load allowed chat IDs from user config
  const userConfig = config.telegram || {};
  const allowedChatIds = (userConfig.allowedChatIds || []).map(String);

  // Verify token
  const me = await tg(token, 'getMe');
  console.log(`Telegram bot: @${me.username}`);

  // Register slash commands with Telegram (shows in the menu)
  try {
    await tg(token, 'setMyCommands', {
      commands: Object.entries(COMMANDS).map(([cmd, { desc }]) => ({
        command: cmd.slice(1), // remove leading /
        description: desc,
      })),
    });
  } catch (err) {
    console.error(`Telegram: failed to set commands menu: ${err.message}`);
  }

  const sessionMap = await loadSessionMap();
  let offset = 0;
  let running = true;

  // Long polling loop
  const poll = async () => {
    while (running) {
      try {
        const updates = await tg(token, 'getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message'],
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            // Handle messages sequentially to avoid session race conditions
            await handleMessage(token, update.message, sessionMap, allowedChatIds);
          }
        }
      } catch (err) {
        if (!running) break;
        console.error(`Telegram poll error: ${err.message}`);
        // Back off on error
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };

  // Start polling in background
  poll();

  // Return stop function + bot info
  const stop = () => { running = false; };
  stop.botName = me.username;
  return stop;
}

// Setup: store bot token and verify
export async function setupTelegram() {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log('Telegram Bot Setup');
  console.log('──────────────────');
  console.log('1. Open Telegram and message @BotFather');
  console.log('2. Send /newbot and follow the prompts');
  console.log('3. Copy the bot token\n');

  const token = await ask('Bot token: ');
  if (!token.trim()) {
    console.log('Cancelled.');
    rl.close();
    return;
  }

  // Verify token
  try {
    const me = await tg(token.trim(), 'getMe');
    console.log(`\nBot verified: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.error(`\nInvalid token: ${err.message}`);
    rl.close();
    return;
  }

  // Store in Keychain
  const { setCredential } = await import('../credentials.js');
  await setCredential('telegram_bot_token', token.trim());
  console.log('Token stored in Keychain.');

  // Ask for allowed chat IDs
  console.log('\nTo restrict who can message the bot, send a message to @userinfobot');
  console.log('to get your chat ID, then enter it below (or press Enter to skip).\n');

  const chatIds = await ask('Allowed chat IDs (comma-separated, or Enter to skip): ');
  if (chatIds.trim()) {
    const ids = chatIds.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`\nAdd this to ~/.betterbot/config.json:`);
    console.log(JSON.stringify({ telegram: { allowedChatIds: ids } }, null, 2));
  }

  rl.close();
  console.log('\nDone! Start the gateway to activate: betterbot gateway');
}
