import { getCredential } from './credentials.js';
import { listCustomTools } from './custom-tools.js';
import { listCronJobs } from './crons.js';
import { findChrome } from './browser.js';
import config from '../config.js';

/**
 * Capability registry — everything the agent CAN do, with status checks.
 *
 * Each capability has:
 *   - name: display name
 *   - description: what it enables
 *   - check(): async function that returns { ready, missing, setup }
 *     - ready: boolean
 *     - missing: what's not configured yet
 *     - setup: instructions for the agent to set it up
 */

const capabilities = [
  {
    name: 'Email (Read/Send)',
    description: 'Check inbox, read emails, send emails via Gmail',
    async check() {
      const email = await getCredential('google_email');
      const pass = await getCredential('google_app_password');
      if (email && pass) return { ready: true };
      const missing = [];
      if (!email) missing.push('google_email');
      if (!pass) missing.push('google_app_password');
      return {
        ready: false,
        missing: `Credentials: ${missing.join(', ')}`,
        setup: 'Ask the user for their Gmail address and Google App Password (not their regular password — they generate an App Password at myaccount.google.com > Security > App Passwords). Store both with store_credential().',
      };
    },
  },

  {
    name: 'Telegram (Receive)',
    description: 'Receive messages from user via Telegram bot',
    async check() {
      const token = await getCredential('telegram_bot_token');
      const chatIds = config.telegram?.allowedChatIds;
      if (token && chatIds?.length > 0) return { ready: true };
      const missing = [];
      if (!token) missing.push('telegram_bot_token credential');
      if (!chatIds?.length) missing.push('telegram.allowedChatIds in config');
      return {
        ready: false,
        missing: missing.join(', '),
        setup: 'User needs to: 1) Create a bot via @BotFather on Telegram, 2) Store the token with store_credential("telegram_bot_token", "..."), 3) Send a message to the bot, then set their chat ID in config. Run "claw telegram setup" for guided setup.',
      };
    },
  },

  {
    name: 'Telegram (Send)',
    description: 'Proactively send messages to the user on Telegram',
    async check() {
      const token = await getCredential('telegram_bot_token');
      const chatId = await getCredential('telegram_chat_id');
      const tools = await listCustomTools();
      const hasTool = tools.some(t => t.name === 'send_telegram' || t.name === 'send_telegram_raw');
      if (token && chatId && hasTool) return { ready: true };
      const missing = [];
      if (!token) missing.push('telegram_bot_token credential');
      if (!chatId) missing.push('telegram_chat_id credential');
      if (!hasTool) missing.push('send_telegram custom tool');
      return {
        ready: false,
        missing: missing.join(', '),
        setup: 'Step 1: Get the bot token from the user and store with store_credential("telegram_bot_token", token). Step 2: To auto-detect chat ID, ask the user to send ANY message to the bot, then fetch("https://api.telegram.org/bot{TOKEN}/getUpdates") — the chat ID is in result[0].message.chat.id. Store with store_credential("telegram_chat_id", id). Step 3: Build send_telegram tool that POSTs to https://api.telegram.org/bot{TOKEN}/sendMessage with {chat_id, text, parse_mode:"Markdown"}. Use get_credential() for both token and chat_id inside the tool.',
      };
    },
  },

  {
    name: 'Web Search',
    description: 'Search the internet for current information, news, research',
    async check() {
      // Built-in web_search tool is always present — just needs an API key
      const tavily = await getCredential('tavily_api_key');
      const perplexity = await getCredential('perplexity_api_key');
      const brave = await getCredential('brave_search_key');

      if (tavily || perplexity || brave) return { ready: true };

      return {
        ready: false,
        missing: 'Search API key (tavily_api_key, perplexity_api_key, or brave_search_key)',
        setup: 'Store one of: tavily_api_key (tavily.com), perplexity_api_key (perplexity.ai), or brave_search_key (brave.com/search/api) via store_credential(). The built-in web_search tool auto-detects which is configured.',
      };
    },
  },

  {
    name: 'Web Browse',
    description: 'Fetch and read specific web pages, documentation, articles (NOT search — use Web Search for that)',
    async check() {
      const tools = await listCustomTools();
      const hasTool = tools.some(t =>
        t.name === 'browse_url' || t.name === 'fetch_url' || t.name === 'read_webpage'
      );
      if (hasTool) return { ready: true };
      return {
        ready: false,
        missing: 'browse_url custom tool',
        setup: 'Build a browse_url tool using fetch(). This works for reading SPECIFIC URLs (docs, articles, APIs) — NOT for Google search. Strip <script>, <style>, HTML tags, decode entities, cap at 5000 chars. No API key needed.',
      };
    },
  },

  {
    name: 'Browser',
    description: 'Browse websites, interact with pages, extract content (core — uses ARIA snapshots, no vision needed)',
    async check() {
      const chrome = findChrome();
      if (chrome) return { ready: true };
      return {
        ready: false,
        missing: 'Chrome/Chromium not installed',
        setup: 'Install Google Chrome, Chromium, or Brave Browser. The browse_web tool uses Chrome DevTools Protocol — no npm packages needed.',
      };
    },
  },

  {
    name: 'Apple Calendar',
    description: 'Read and create events in Apple Calendar via AppleScript',
    async check() {
      const tools = await listCustomTools();
      const hasRead = tools.some(t =>
        t.name.includes('calendar') && (t.name.includes('check') || t.name.includes('get') || t.name.includes('read'))
      );
      const hasWrite = tools.some(t =>
        t.name.includes('calendar') && (t.name.includes('add') || t.name.includes('create'))
      );
      if (hasRead && hasWrite) return { ready: true };
      const missing = [];
      if (!hasRead) missing.push('calendar read tool');
      if (!hasWrite) missing.push('calendar write tool');
      return {
        ready: false,
        missing: missing.join(', '),
        setup: 'Build tools using AppleScript via child_process execSync("osascript -e \'...\'"). For reading: query Calendar app for events on a given date. For writing: tell Calendar to make new event in the target calendar. Target calendar should be the user\'s primary (ask or detect with get_calendar_names).',
      };
    },
  },

  {
    name: 'Apple Reminders',
    description: 'Create and check reminders in Apple Reminders',
    async check() {
      const tools = await listCustomTools();
      const hasTool = tools.some(t => t.name.includes('reminder'));
      if (hasTool) return { ready: true };
      return {
        ready: false,
        missing: 'reminders custom tool',
        setup: 'Build tools using AppleScript: "tell application \\"Reminders\\" to make new reminder in list \\"Reminders\\" with properties {name: ..., due date: ...}". Also build a read tool to list incomplete reminders.',
      };
    },
  },

  {
    name: 'Scheduled Tasks (Crons)',
    description: 'Run tasks on a schedule (e.g. morning email check, weekly reports)',
    async check() {
      const crons = await listCronJobs();
      const enabled = crons.filter(c => c.enabled);
      if (enabled.length > 0) return { ready: true };
      return {
        ready: false,
        missing: 'No cron jobs configured',
        setup: 'Use create_cron() to schedule recurring tasks. Examples: "0 9 * * 1-5" for weekday mornings, "0 18 * * 5" for Friday evening. The prompt should be specific instructions for what to do.',
      };
    },
  },

  {
    name: 'GitHub',
    description: 'Check notifications, PRs, issues via gh CLI',
    async check() {
      try {
        const { execSync } = await import('node:child_process');
        execSync('gh auth status', { stdio: 'pipe', timeout: 5000 });
        return { ready: true };
      } catch {
        return {
          ready: false,
          missing: 'gh CLI not authenticated',
          setup: 'User needs to run "gh auth login" in their terminal to authenticate the GitHub CLI.',
        };
      }
    },
  },

  {
    name: 'Notion',
    description: 'Read and write Notion pages and databases',
    async check() {
      const key = await getCredential('notion_api_key');
      const tools = await listCustomTools();
      const hasTool = tools.some(t => t.name.includes('notion'));
      if (key && hasTool) return { ready: true };
      const missing = [];
      if (!key) missing.push('notion_api_key credential');
      if (!hasTool) missing.push('notion custom tools');
      return {
        ready: false,
        missing: missing.join(', '),
        setup: 'User creates an integration at notion.so/my-integrations, gets the API key, stores with store_credential("notion_api_key"). Then build tools: query_notion_db(database_id, filter), read_notion_page(page_id), create_notion_page(database_id, properties) using the Notion REST API.',
      };
    },
  },

  {
    name: 'Slack',
    description: 'Send messages and read channels in Slack',
    async check() {
      const token = await getCredential('slack_bot_token');
      const tools = await listCustomTools();
      const hasTool = tools.some(t => t.name.includes('slack'));
      if (token && hasTool) return { ready: true };
      const missing = [];
      if (!token) missing.push('slack_bot_token credential');
      if (!hasTool) missing.push('slack custom tools');
      return {
        ready: false,
        missing: missing.join(', '),
        setup: 'User creates a Slack app at api.slack.com/apps, adds chat:write + channels:read scopes, installs to workspace, stores bot token with store_credential("slack_bot_token"). Then build tools using Slack Web API (POST https://slack.com/api/chat.postMessage etc.).',
      };
    },
  },
];

/**
 * Check all capabilities and return their status.
 * Returns array of { name, description, ready, missing?, setup? }
 */
export async function checkCapabilities() {
  const results = [];
  for (const cap of capabilities) {
    try {
      const status = await cap.check();
      results.push({
        name: cap.name,
        description: cap.description,
        ...status,
      });
    } catch {
      results.push({
        name: cap.name,
        description: cap.description,
        ready: false,
        missing: 'Check failed',
      });
    }
  }
  return results;
}

/**
 * Get a compact summary for the system prompt.
 * Just status — setup details live in capability context files.
 */
export async function getCapabilitySummary() {
  const caps = await checkCapabilities();
  const ready = caps.filter(c => c.ready);
  const notReady = caps.filter(c => !c.ready);

  const lines = [];

  if (ready.length > 0) {
    lines.push('Active: ' + ready.map(c => c.name).join(', '));
  }

  if (notReady.length > 0) {
    lines.push('Inactive: ' + notReady.map(c => c.name).join(', '));
  }

  lines.push('To set up a capability: load_context("cap-<name>") for instructions (e.g. cap-email, cap-telegram, cap-search, cap-crons).');

  return lines.join('\n');
}
