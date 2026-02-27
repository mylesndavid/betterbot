import { tui } from './init.js';
import { setCredential, getCredential } from './credentials.js';
import { checkCapabilities } from './capabilities.js';
import config, { userConfigPath } from '../config.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const { select, input, confirm, info, c, CLEAR, SHOW_CURSOR, write } = tui;

// ══════════════════════════════════════════════════════════
// Setup menu — `betterbot setup`
// ══════════════════════════════════════════════════════════

export async function runSetup(target) {
  const stdin = process.stdin;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();

  try {
    if (target) {
      // Direct: `betterbot setup telegram`
      const flow = setupFlows[target];
      if (!flow) {
        console.log(`Unknown capability: ${target}`);
        console.log(`Available: ${Object.keys(setupFlows).join(', ')}`);
        return;
      }
      await flow();
    } else {
      // Interactive: `betterbot setup` — show capability status and pick one
      await runSetupMenu();
    }
  } finally {
    write(SHOW_CURSOR);
    if (stdin.setRawMode) stdin.setRawMode(false);
    stdin.pause();
  }
}

async function runSetupMenu() {
  const caps = await checkCapabilities();

  const options = [];
  for (const cap of caps) {
    const flowKey = capabilityToFlow(cap.name);
    if (!flowKey || !setupFlows[flowKey]) continue;
    const status = cap.ready ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    options.push({
      label: `${status} ${cap.name}`,
      hint: cap.ready ? 'configured' : cap.missing,
      value: flowKey,
    });
  }
  options.push({ label: `${c.dim}Exit${c.reset}`, value: null });

  const choice = await select('Setup a Capability', options);
  if (!choice) return;

  await setupFlows[choice]();

  // Offer to set up another
  const again = await confirm('Setup Complete', 'Set up another capability?', false);
  if (again) await runSetupMenu();
}

function capabilityToFlow(name) {
  const map = {
    'Email (Read/Send)': 'email',
    'Telegram (Receive)': 'telegram',
    'Telegram (Send)': 'telegram',
    'Web Search': 'search',
    'Web Browse': 'browse',
    'Apple Calendar': 'calendar',
    'Apple Reminders': 'reminders',
    'iMessage': 'imessage',
    'Scheduled Tasks (Crons)': null, // no setup flow needed
    'BetterFriends': 'betterfriends',
    'GitHub': 'github',
    'Notion': 'notion',
    'Slack': 'slack',
  };
  return map[name];
}

// ══════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════

function loadOverrides() {
  try { return JSON.parse(readFileSync(userConfigPath, 'utf-8')); }
  catch { return {}; }
}

function saveOverrides(overrides) {
  const dir = dirname(userConfigPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(userConfigPath, JSON.stringify(overrides, null, 2), 'utf-8');
}

async function testStep(label, fn) {
  write(`\n  ${c.dim}Testing: ${label}...${c.reset}`);
  try {
    const result = await fn();
    write(`\r  ${c.green}✓ ${label}${c.reset}${' '.repeat(40)}\n`);
    return result;
  } catch (err) {
    write(`\r  ${c.red}✗ ${label}: ${err.message}${c.reset}${' '.repeat(20)}\n`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// Telegram Setup
// ══════════════════════════════════════════════════════════

async function setupTelegram() {
  info('Telegram Setup', [
    '',
    `${c.bold}Step 1: Create a Telegram Bot${c.reset}`,
    '',
    `  1. Open Telegram and search for ${c.cyan}@BotFather${c.reset}`,
    `  2. Send ${c.cyan}/newbot${c.reset} and follow the prompts`,
    `  3. Copy the bot token (looks like ${c.dim}123456:ABC-DEF...${c.reset})`,
    '',
    `${c.dim}Press Enter when you have your token...${c.reset}`,
  ]);
  await tui.readKey();

  const token = await input('Bot Token', 'Paste your bot token', '', { secret: true });
  if (!token) { console.log('Setup cancelled.'); return; }

  // Validate token
  write(CLEAR);
  const valid = await testStep('Validating bot token', async () => {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Invalid token');
    return data.result;
  });

  if (!valid) {
    console.log(`\n  ${c.red}Token is invalid. Please check and try again.${c.reset}\n`);
    return;
  }

  console.log(`\n  ${c.green}Bot found: @${valid.username} (${valid.first_name})${c.reset}\n`);

  // Store token
  await setCredential('telegram_bot_token', token);
  console.log(`  ${c.green}✓ Token stored in Keychain${c.reset}`);

  // Detect chat ID
  info('Telegram Setup', [
    '',
    `${c.bold}Step 2: Link your account${c.reset}`,
    '',
    `  Open Telegram and send ANY message to ${c.cyan}@${valid.username}${c.reset}`,
    '',
    `${c.dim}Press Enter after you've sent a message...${c.reset}`,
  ]);
  await tui.readKey();

  write(CLEAR);
  const chatId = await testStep('Detecting your chat ID', async () => {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=5`);
    const data = await res.json();
    if (!data.ok || !data.result?.length) throw new Error('No messages received. Did you send a message to the bot?');
    // Get the most recent message's chat ID
    const latest = data.result[data.result.length - 1];
    const chat = latest.message?.chat || latest.edited_message?.chat;
    if (!chat?.id) throw new Error('Could not detect chat ID from messages');
    return chat;
  });

  if (!chatId) {
    console.log(`\n  ${c.yellow}Could not auto-detect. You can set it manually:${c.reset}`);
    console.log(`  ${c.dim}betterbot creds set telegram_chat_id YOUR_CHAT_ID${c.reset}\n`);

    const manualId = await input('Chat ID', 'Enter your chat ID manually (or leave empty to skip)', '');
    if (manualId) {
      await setCredential('telegram_chat_id', manualId);
      console.log(`  ${c.green}✓ Chat ID stored${c.reset}`);
    }
  } else {
    console.log(`\n  ${c.green}Detected: ${chatId.first_name || chatId.username || 'User'} (${chatId.id})${c.reset}`);
    await setCredential('telegram_chat_id', String(chatId.id));
    console.log(`  ${c.green}✓ Chat ID stored in Keychain${c.reset}`);

    // Save to config allowedChatIds
    const overrides = loadOverrides();
    if (!overrides.telegram) overrides.telegram = {};
    if (!overrides.telegram.allowedChatIds) overrides.telegram.allowedChatIds = [];
    if (!overrides.telegram.allowedChatIds.includes(String(chatId.id))) {
      overrides.telegram.allowedChatIds.push(String(chatId.id));
      saveOverrides(overrides);
      console.log(`  ${c.green}✓ Chat ID added to allowedChatIds in config${c.reset}`);
    }
  }

  // Test: send a message
  const shouldTest = await confirm('Test', 'Send a test message to verify?');
  if (shouldTest) {
    const cid = await getCredential('telegram_chat_id');
    await testStep('Sending test message', async () => {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cid,
          text: `✅ *BetterBot Telegram Connected*\n\n${config.agentName} can now message you here.`,
          parse_mode: 'Markdown',
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
    });
  }

  console.log(`\n  ${c.green}${c.bold}Telegram setup complete!${c.reset}`);
  console.log(`  ${c.dim}Start the gateway with: betterbot gateway${c.reset}\n`);
}

// ══════════════════════════════════════════════════════════
// Email Setup
// ══════════════════════════════════════════════════════════

async function setupEmail() {
  info('Email Setup (Gmail)', [
    '',
    `${c.bold}Gmail App Password Required${c.reset}`,
    '',
    `  BetterBot uses an App Password (not your regular password)`,
    `  to access Gmail via IMAP/SMTP.`,
    '',
    `  ${c.cyan}How to get one:${c.reset}`,
    `  1. Go to ${c.cyan}myaccount.google.com${c.reset}`,
    `  2. Security → 2-Step Verification (must be ON)`,
    `  3. Search "App Passwords" or go to App Passwords section`,
    `  4. Create one for "Mail" → "Mac"`,
    `  5. Copy the 16-character password`,
    '',
    `${c.dim}Press Enter to continue...${c.reset}`,
  ]);
  await tui.readKey();

  const email = await input('Gmail Address', 'Your Gmail address', '', { prefill: '' });
  if (!email) { console.log('Setup cancelled.'); return; }

  const appPassword = await input('App Password', 'Paste your 16-char app password', '', { secret: true });
  if (!appPassword) { console.log('Setup cancelled.'); return; }

  await setCredential('google_email', email);
  await setCredential('google_app_password', appPassword);
  console.log(`\n  ${c.green}✓ Credentials stored in Keychain${c.reset}`);

  // Test IMAP connection
  write(CLEAR);
  const imapOk = await testStep('Connecting to Gmail IMAP', async () => {
    const { connect } = await import('node:tls');
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: 'imap.gmail.com', port: 993,
        servername: 'imap.gmail.com', rejectUnauthorized: true,
      }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 10000);
    });
  });

  if (imapOk) {
    const emailOk = await testStep('Checking inbox', async () => {
      const { checkEmail } = await import('./email.js');
      const msgs = await checkEmail({ limit: 3 });
      return `${msgs.length} messages found`;
    });
    if (emailOk) console.log(`  ${c.dim}${emailOk}${c.reset}`);
  }

  console.log(`\n  ${c.green}${c.bold}Email setup complete!${c.reset}`);
  console.log(`  ${c.dim}Your agent can now check_email, read_email, and send_email.${c.reset}\n`);
}

// ══════════════════════════════════════════════════════════
// Web Search Setup
// ══════════════════════════════════════════════════════════

async function setupSearch() {
  const provider = await select('Search API Provider', [
    { label: 'Serper (Google Search API)', hint: 'serper.dev — 2500 free/mo', value: 'serper' },
    { label: 'Brave Search', hint: 'brave.com/search/api — 2000 free/mo', value: 'brave' },
  ]);
  if (!provider) return;

  if (provider === 'serper') {
    info('Serper Setup', [
      '',
      `${c.bold}Get a Serper API Key${c.reset}`,
      '',
      `  1. Go to ${c.cyan}serper.dev${c.reset}`,
      `  2. Sign up (free tier: 2,500 searches/month)`,
      `  3. Copy your API key from the dashboard`,
      '',
      `${c.dim}Press Enter when ready...${c.reset}`,
    ]);
    await tui.readKey();

    const key = await input('Serper API Key', 'Paste your API key', '', { secret: true });
    if (!key) { console.log('Setup cancelled.'); return; }

    await setCredential('serper_api_key', key);
    console.log(`\n  ${c.green}✓ API key stored in Keychain${c.reset}`);

    // Test
    write(CLEAR);
    await testStep('Testing search', async () => {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'test' }),
      });
      const data = await res.json();
      if (data.organic?.length > 0) return true;
      throw new Error(data.message || 'No results');
    });

  } else {
    info('Brave Search Setup', [
      '',
      `${c.bold}Get a Brave Search API Key${c.reset}`,
      '',
      `  1. Go to ${c.cyan}brave.com/search/api${c.reset}`,
      `  2. Sign up for the free plan (2,000 queries/month)`,
      `  3. Copy your subscription token`,
      '',
      `${c.dim}Press Enter when ready...${c.reset}`,
    ]);
    await tui.readKey();

    const key = await input('Brave API Key', 'Paste your subscription token', '', { secret: true });
    if (!key) { console.log('Setup cancelled.'); return; }

    await setCredential('brave_search_key', key);
    console.log(`\n  ${c.green}✓ API key stored in Keychain${c.reset}`);

    // Test
    write(CLEAR);
    await testStep('Testing search', async () => {
      const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test', {
        headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
      });
      const data = await res.json();
      if (data.web?.results?.length > 0) return true;
      throw new Error(data.message || 'No results');
    });
  }

  console.log(`\n  ${c.green}${c.bold}Web search setup complete!${c.reset}`);
  console.log(`  ${c.dim}Your agent will auto-build a web_search tool using this key.${c.reset}\n`);
}

// ══════════════════════════════════════════════════════════
// Web Browse Setup (no API key needed)
// ══════════════════════════════════════════════════════════

async function setupBrowse() {
  info('Web Browse', [
    '',
    `${c.bold}No API key needed!${c.reset}`,
    '',
    `  Web browse uses built-in fetch() to read web pages.`,
    `  Your agent will build this tool automatically when needed.`,
    '',
    `  ${c.dim}This capability is self-configuring — your agent creates the${c.reset}`,
    `  ${c.dim}browse_url tool on first use.${c.reset}`,
    '',
    `${c.dim}Press Enter to continue...${c.reset}`,
  ]);
  await tui.readKey();
  console.log(`\n  ${c.green}No setup required. Your agent will build this automatically.${c.reset}\n`);
}

// ══════════════════════════════════════════════════════════
// Apple Calendar Setup (test AppleScript access)
// ══════════════════════════════════════════════════════════

async function setupCalendar() {
  write(CLEAR);
  console.log(`\n  ${c.bold}Apple Calendar Setup${c.reset}\n`);

  const ok = await testStep('Testing Calendar access via AppleScript', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('osascript -e \'tell application "Calendar" to name of calendars\'', {
      encoding: 'utf-8', timeout: 10000,
    });
    return result.trim();
  });

  if (ok) {
    console.log(`  ${c.dim}Calendars: ${ok}${c.reset}`);
    console.log(`\n  ${c.green}${c.bold}Calendar access works!${c.reset}`);
    console.log(`  ${c.dim}Your agent will build calendar tools automatically when you ask.${c.reset}\n`);
  } else {
    console.log(`\n  ${c.yellow}Calendar access denied. You may need to grant Terminal access${c.reset}`);
    console.log(`  ${c.dim}System Settings → Privacy & Security → Automation${c.reset}\n`);
  }
}

// ══════════════════════════════════════════════════════════
// Apple Reminders Setup
// ══════════════════════════════════════════════════════════

async function setupReminders() {
  write(CLEAR);
  console.log(`\n  ${c.bold}Apple Reminders Setup${c.reset}\n`);

  const ok = await testStep('Testing Reminders access via AppleScript', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('osascript -e \'tell application "Reminders" to name of lists\'', {
      encoding: 'utf-8', timeout: 10000,
    });
    return result.trim();
  });

  if (ok) {
    console.log(`  ${c.dim}Lists: ${ok}${c.reset}`);
    console.log(`\n  ${c.green}${c.bold}Reminders access works!${c.reset}`);
    console.log(`  ${c.dim}Your agent will build reminder tools when you ask.${c.reset}\n`);
  } else {
    console.log(`\n  ${c.yellow}Reminders access denied. Check System Settings → Automation.${c.reset}\n`);
  }
}

// ══════════════════════════════════════════════════════════
// iMessage Setup
// ══════════════════════════════════════════════════════════

async function setupImessage() {
  write(CLEAR);
  console.log(`\n  ${c.bold}iMessage Setup${c.reset}\n`);
  console.log(`  ${c.dim}iMessage requires two separate macOS permissions:${c.reset}`);
  console.log(`  ${c.dim}  1. Automation — to send messages via Messages app${c.reset}`);
  console.log(`  ${c.dim}  2. Full Disk Access — to read message history from chat.db${c.reset}\n`);

  // Test 1: AppleScript (Automation)
  const canSend = await testStep('Messages app access (Automation)', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('osascript -e \'tell application "Messages" to name\'', {
      encoding: 'utf-8', timeout: 10000,
    });
    return result.trim();
  });

  // Test 2: chat.db (Full Disk Access)
  const canRead = await testStep('Message history access (Full Disk Access)', async () => {
    const { execSync } = await import('node:child_process');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const dbPath = join(homedir(), 'Library/Messages/chat.db');
    const result = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM message"`, {
      encoding: 'utf-8', timeout: 5000,
    });
    return `${result.trim()} messages in database`;
  });

  if (canSend && canRead) {
    console.log(`\n  ${c.green}${c.bold}iMessage is fully set up!${c.reset}`);
    console.log(`  ${c.dim}Your agent can send and read iMessages.${c.reset}\n`);
  } else if (canSend) {
    console.log(`\n  ${c.yellow}Sending works, but reading requires Full Disk Access.${c.reset}`);
    console.log(`  ${c.dim}System Settings → Privacy & Security → Full Disk Access${c.reset}`);
    console.log(`  ${c.dim}Add your terminal app (Terminal, iTerm2, etc.)${c.reset}\n`);
  } else {
    console.log(`\n  ${c.yellow}Messages access denied.${c.reset}`);
    console.log(`  ${c.dim}System Settings → Privacy & Security → Automation${c.reset}`);
    console.log(`  ${c.dim}Enable Messages for your terminal app.${c.reset}\n`);
  }
}

// ══════════════════════════════════════════════════════════
// GitHub Setup
// ══════════════════════════════════════════════════════════

async function setupGitHub() {
  write(CLEAR);
  console.log(`\n  ${c.bold}GitHub Setup${c.reset}\n`);

  const ok = await testStep('Checking gh CLI authentication', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('gh auth status 2>&1', { encoding: 'utf-8', timeout: 10000 });
    return result;
  });

  if (ok) {
    console.log(`\n  ${c.green}${c.bold}GitHub is already configured!${c.reset}\n`);
  } else {
    console.log(`\n  ${c.yellow}gh CLI not authenticated.${c.reset}`);
    console.log(`  Run this in your terminal:\n`);
    console.log(`  ${c.cyan}gh auth login${c.reset}\n`);
    console.log(`  ${c.dim}Then re-run: betterbot setup github${c.reset}\n`);
  }
}

// ══════════════════════════════════════════════════════════
// Notion Setup
// ══════════════════════════════════════════════════════════

async function setupNotion() {
  info('Notion Setup', [
    '',
    `${c.bold}Create a Notion Integration${c.reset}`,
    '',
    `  1. Go to ${c.cyan}notion.so/my-integrations${c.reset}`,
    `  2. Click "New integration"`,
    `  3. Give it a name (e.g. "BetterBot")`,
    `  4. Copy the "Internal Integration Secret"`,
    `  5. Share your databases with the integration`,
    '',
    `${c.dim}Press Enter when ready...${c.reset}`,
  ]);
  await tui.readKey();

  const key = await input('Notion API Key', 'Paste your integration secret', '', { secret: true });
  if (!key) { console.log('Setup cancelled.'); return; }

  await setCredential('notion_api_key', key);
  console.log(`\n  ${c.green}✓ API key stored in Keychain${c.reset}`);

  // Test
  write(CLEAR);
  await testStep('Testing Notion API', async () => {
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: { 'Authorization': `Bearer ${key}`, 'Notion-Version': '2022-06-28' },
    });
    const data = await res.json();
    if (data.object === 'user') return `Connected as: ${data.name || data.id}`;
    throw new Error(data.message || 'Invalid key');
  });

  console.log(`\n  ${c.green}${c.bold}Notion setup complete!${c.reset}`);
  console.log(`  ${c.dim}Your agent will build Notion tools when you ask it to interact with your workspace.${c.reset}\n`);
}

// ══════════════════════════════════════════════════════════
// Slack Setup
// ══════════════════════════════════════════════════════════

async function setupSlack() {
  info('Slack Setup', [
    '',
    `${c.bold}Create a Slack App${c.reset}`,
    '',
    `  1. Go to ${c.cyan}api.slack.com/apps${c.reset}`,
    `  2. Create New App → From Scratch`,
    `  3. Add scopes: ${c.cyan}chat:write${c.reset}, ${c.cyan}channels:read${c.reset}, ${c.cyan}channels:history${c.reset}`,
    `  4. Install to your workspace`,
    `  5. Copy the Bot User OAuth Token`,
    '',
    `${c.dim}Press Enter when ready...${c.reset}`,
  ]);
  await tui.readKey();

  const token = await input('Slack Bot Token', 'Paste your bot token (xoxb-...)', '', { secret: true });
  if (!token) { console.log('Setup cancelled.'); return; }

  await setCredential('slack_bot_token', token);
  console.log(`\n  ${c.green}✓ Token stored in Keychain${c.reset}`);

  // Test
  write(CLEAR);
  await testStep('Testing Slack API', async () => {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.ok) return `Connected as: ${data.user} in ${data.team}`;
    throw new Error(data.error || 'Invalid token');
  });

  console.log(`\n  ${c.green}${c.bold}Slack setup complete!${c.reset}`);
  console.log(`  ${c.dim}Your agent will build Slack tools when you ask it to send messages.${c.reset}\n`);
}

// ══════════════════════════════════════════════════════════
// Flow registry
// ══════════════════════════════════════════════════════════

async function setupBetterfriends() {
  const { setupBetterFriends } = await import('./channels/betterfriends.js');
  await setupBetterFriends();
}

const setupFlows = {
  telegram: setupTelegram,
  email: setupEmail,
  search: setupSearch,
  browse: setupBrowse,
  calendar: setupCalendar,
  reminders: setupReminders,
  imessage: setupImessage,
  github: setupGitHub,
  notion: setupNotion,
  slack: setupSlack,
  betterfriends: setupBetterfriends,
};
