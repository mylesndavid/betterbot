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
  dataDir: join(home, '.betterclaw'),
  sessionsDir: join(home, '.betterclaw/sessions'),
  workspaceDir: join(home, '.betterclaw/workspace'),
  contextsDir: join(__dirname, 'contexts'),

  // Vault folders (PARA + agent)
  para: {
    inbox:     '00_Inbox',
    projects:  'Projects',
    areas:     'Areas',
    resources: 'Resources',
    archive:   'Archive',
  },
  dailyNotesDir: 'Daily',
  memoriesDir: 'Memories',
  skillsDir: 'Resources/Skills',

  // Model roles → provider + model
  models: {
    router:  { provider: 'ollama',    model: 'llama3.2:3b' },
    quick:   { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    default: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250514' },
    deep:    { provider: 'openai',    model: 'o3' },
    browser: { provider: 'openrouter', model: 'google/gemini-3-flash-preview' },
  },

  // Compaction
  compaction: {
    keepRecentMessages: 10,
    maxMessagesBeforeCompact: 30,
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

export const userConfigPath = join(home, '.betterclaw', 'config.json');

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
