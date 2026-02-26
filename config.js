import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const home = homedir();

const defaults = {
  // Agent
  agentName: 'Agent',

  // Paths
  vault: join(home, 'Library/Mobile Documents/iCloud~md~obsidian/Documents'),
  dataDir: join(home, '.betterbot'),
  sessionsDir: join(home, '.betterbot/sessions'),
  workspaceDir: join(home, '.betterbot/workspace'),
  contextsDir: join(__dirname, 'contexts'),
  outfitsDir: join(home, '.betterbot/outfits'),
  graphDir: join(home, '.betterbot/graph'),

  // Vault folders
  para: {
    inbox:     '00_Inbox',
    projects:  'Projects',
    resources: 'Resources',
  },
  dailyNotesDir: 'Daily',
  skillsDir: 'Resources/Skills',

  // Model roles → provider + model
  // Only 'default' is set here. Other roles (router, quick, deep, browser)
  // are left undefined so they fall back to 'default' via createProvider().
  // This prevents crashes when a new user doesn't have every provider configured.
  models: {
    default: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250514' },
  },

  // Compaction
  compaction: {
    keepRecentMessages: 10,       // user turns (not raw messages) to keep verbatim after compaction
    maxMessagesBeforeCompact: 30,  // user turns before triggering compaction
    maxTokens: 100_000,           // estimated token limit — compact if messages exceed this
  },

  // Budget
  budget: {
    dailyLimit: 2.00,  // USD
    warnAt: 1.50,
  },

  // Notifications & escalation
  notifyChannel: 'telegram',  // default channel for escalation notifications (telegram, slack, etc.)
  escalation: {
    mode: 'notify',           // 'notify' = one-way push + context handoff, 'inject' = use active session directly
  },

  // Heartbeat
  heartbeat: {
    intervalMinutes: 15,
    sources: ['inbox', 'tasks', 'github'],
    proactive: true,          // idle awareness — triage model decides whether to check in
  },

  // Credential names
  credentialKeys: [
    'anthropic_api_key',
    'openai_api_key',
    'openrouter_api_key',
    'together_api_key',
    'groq_api_key',
    'gh_token',
    'telegram_bot_token',
    'telegram_chat_id',
    'google_email',
    'google_app_password',
    'serper_api_key',
    'brave_search_key',
    'tavily_api_key',
    'perplexity_api_key',
    'notion_api_key',
    'slack_bot_token',
  ],
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export const userConfigPath = join(home, '.betterbot', 'config.json');

function loadUserConfig() {
  try {
    const raw = readFileSync(userConfigPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const config = deepMerge(defaults, loadUserConfig());

export { defaults };
export default config;
