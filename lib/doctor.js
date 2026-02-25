import { readdir, readFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import config from '../config.js';
import { getCredential } from './credentials.js';

const TOOLS_DIR = join(config.dataDir, 'custom-tools');
const QUARANTINE_DIR = join(config.dataDir, 'custom-tools-quarantine');
const PID_PATH = join(config.dataDir, 'gateway.pid');

const green = '\x1b[32m';
const red = '\x1b[31m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

function ok(msg) { console.log(`  ${green}✓${reset} ${msg}`); }
function warn(msg) { console.log(`  ${yellow}⚠${reset} ${msg}`); }
function fail(msg) { console.log(`  ${red}✗${reset} ${msg}`); }
function info(msg) { console.log(`  ${dim}${msg}${reset}`); }

// Provider → credential key mapping
const PROVIDER_CRED = {
  anthropic: 'anthropic_api_key',
  openai: 'openai_api_key',
  openrouter: 'openrouter_api_key',
  together: 'together_api_key',
  groq: 'groq_api_key',
  ollama: null,
  pollinations: null,
  generic: null,
};

// ── Checks ───────────────────────────────────────────────────────

async function checkConfig() {
  console.log(`\n${bold}Config Health${reset}`);

  const defaultModel = config.models?.default;
  if (!defaultModel) {
    fail('No default model configured. Run: betterbot init');
    return false;
  }

  ok(`Default model: ${defaultModel.provider}/${defaultModel.model}`);

  const credKey = PROVIDER_CRED[defaultModel.provider];
  if (credKey) {
    const key = await getCredential(credKey);
    if (key) {
      ok(`API key configured: ${credKey}`);
    } else {
      fail(`Missing API key: ${credKey}. Run: betterbot creds set ${credKey} <your-key>`);
      return false;
    }
  } else if (defaultModel.provider === 'ollama') {
    ok('Ollama (no API key needed)');
  }

  // Show other configured roles
  for (const role of ['quick', 'router', 'deep', 'browser']) {
    const spec = config.models[role];
    if (spec) {
      info(`${role}: ${spec.provider}/${spec.model}`);
    } else {
      info(`${role}: falls back to default`);
    }
  }

  return true;
}

async function checkCustomTools(fix = false) {
  console.log(`\n${bold}Custom Tools${reset}`);

  if (!existsSync(TOOLS_DIR)) {
    info('No custom tools directory');
    return { broken: [], duplicates: [] };
  }

  const files = await readdir(TOOLS_DIR);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  if (jsFiles.length === 0) {
    info('No custom tools installed');
    return { broken: [], duplicates: [] };
  }

  // Get built-in tool names
  const builtinNames = new Set();
  try {
    const { tools } = await import('./tools.js');
    for (const t of tools) builtinNames.add(t.name);
  } catch {}

  const broken = [];
  const duplicates = [];
  const loaded = new Map(); // name → file

  for (const file of jsFiles) {
    const fullPath = join(TOOLS_DIR, file);
    try {
      const url = pathToFileURL(fullPath).href + `?t=${Date.now()}`;
      const mod = await import(url);
      const tool = mod.default;

      if (!tool?.name || !tool?.execute) {
        broken.push({ file, reason: 'Missing name or execute function' });
        fail(`${file}: missing name or execute`);
        continue;
      }

      // Check builtin shadow
      if (builtinNames.has(tool.name)) {
        duplicates.push({ file, name: tool.name, reason: 'Shadows built-in tool' });
        fail(`${file}: "${tool.name}" shadows a built-in tool`);
        continue;
      }

      // Check duplicate custom tool name
      if (loaded.has(tool.name)) {
        duplicates.push({ file, name: tool.name, reason: `Duplicate of ${loaded.get(tool.name)}` });
        fail(`${file}: "${tool.name}" duplicates ${loaded.get(tool.name)}`);
        continue;
      }

      loaded.set(tool.name, file);
      ok(`${tool.name} (${file})`);
    } catch (err) {
      broken.push({ file, reason: err.message });
      fail(`${file}: ${err.message.split('\n')[0]}`);
    }
  }

  // Auto-fix: quarantine broken/duplicate tools
  if (fix && (broken.length > 0 || duplicates.length > 0)) {
    if (!existsSync(QUARANTINE_DIR)) {
      await mkdir(QUARANTINE_DIR, { recursive: true });
    }

    const toQuarantine = [...broken, ...duplicates];
    for (const item of toQuarantine) {
      try {
        const src = join(TOOLS_DIR, item.file);
        const dst = join(QUARANTINE_DIR, item.file);
        await rename(src, dst);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(dst + '.reason', `Quarantined by betterbot doctor --fix: ${new Date().toISOString()}\n${item.reason}\n`, 'utf-8');
        warn(`Quarantined: ${item.file}`);
      } catch (err) {
        fail(`Failed to quarantine ${item.file}: ${err.message}`);
      }
    }
  }

  return { broken, duplicates };
}

async function checkQuarantine() {
  console.log(`\n${bold}Quarantine${reset}`);

  if (!existsSync(QUARANTINE_DIR)) {
    info('No quarantined tools');
    return;
  }

  const files = await readdir(QUARANTINE_DIR);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  if (jsFiles.length === 0) {
    info('Quarantine is empty');
    return;
  }

  for (const file of jsFiles) {
    let reason = 'Unknown reason';
    try {
      reason = await readFile(join(QUARANTINE_DIR, file + '.reason'), 'utf-8');
      reason = reason.trim().split('\n').slice(1).join(' ').trim() || reason;
    } catch {}
    warn(`${file}: ${reason}`);
  }
}

async function checkModelConnectivity() {
  console.log(`\n${bold}Model Connectivity${reset}`);

  const defaultModel = config.models?.default;
  if (!defaultModel) {
    fail('No default model to test');
    return false;
  }

  try {
    const { createProvider } = await import('./provider.js');
    const provider = createProvider('default');

    info(`Testing ${defaultModel.provider}/${defaultModel.model}...`);
    const response = await provider.chat(
      [{ role: 'user', content: 'Reply with exactly: ok' }],
      { maxTokens: 5 }
    );

    if (response?.content) {
      ok(`Model responded: "${response.content.slice(0, 20).trim()}"`);
      return true;
    } else {
      fail('Model returned empty response');
      return false;
    }
  } catch (err) {
    fail(`Connection failed: ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function checkGateway() {
  console.log(`\n${bold}Gateway${reset}`);

  if (!existsSync(PID_PATH)) {
    info('Gateway not running (no PID file)');
    return;
  }

  try {
    const pid = parseInt(await readFile(PID_PATH, 'utf-8'), 10);
    if (isNaN(pid)) {
      warn('PID file exists but is invalid');
      return;
    }

    try {
      process.kill(pid, 0); // Signal 0 = check if alive
      ok(`Gateway running (PID ${pid})`);
    } catch {
      warn(`Stale PID file (PID ${pid} not running)`);
    }
  } catch (err) {
    warn(`Can't read PID file: ${err.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────

export async function runDoctor(args = []) {
  const fix = args.includes('--fix');
  const reset_flag = args.includes('--reset');

  console.log(`${bold}BetterBot Doctor${reset}`);

  if (reset_flag) {
    console.log(`\n${yellow}Nuclear reset:${reset}`);

    // Clear custom tools
    if (existsSync(TOOLS_DIR)) {
      await rm(TOOLS_DIR, { recursive: true });
      warn('Deleted custom tools directory');
    }

    // Clear quarantine
    if (existsSync(QUARANTINE_DIR)) {
      await rm(QUARANTINE_DIR, { recursive: true });
      warn('Deleted quarantine directory');
    }

    // Reset config to just agentName (preserve identity)
    const { userConfigPath } = await import('../config.js');
    try {
      const existing = JSON.parse(await readFile(userConfigPath, 'utf-8'));
      const minimal = {};
      if (existing.agentName) minimal.agentName = existing.agentName;
      if (existing.vault) minimal.vault = existing.vault;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(userConfigPath, JSON.stringify(minimal, null, 2), 'utf-8');
      warn('Reset config (kept agentName and vault)');
    } catch {
      warn('No config file to reset');
    }

    console.log(`\n${dim}Run 'betterbot init' to set up again.${reset}`);
    return;
  }

  await checkConfig();
  const { broken, duplicates } = await checkCustomTools(fix);
  await checkQuarantine();
  await checkModelConnectivity();
  await checkGateway();

  // Summary
  const issues = broken.length + duplicates.length;
  console.log();
  if (issues === 0) {
    console.log(`${green}All checks passed.${reset}`);
  } else if (fix) {
    console.log(`${yellow}Fixed ${issues} issue(s). Run 'betterbot doctor' again to verify.${reset}`);
  } else {
    console.log(`${yellow}Found ${issues} issue(s). Run 'betterbot doctor --fix' to auto-repair.${reset}`);
  }
}

/**
 * Headless doctor — runs checks silently and returns structured results.
 * Used by API endpoint and heartbeat. Always auto-fixes (quarantines broken tools).
 */
export async function runDoctorHeadless() {
  const results = { fixed: [], warnings: [], ok: [] };

  // 1. Ensure data dirs
  for (const dir of [config.dataDir, config.sessionsDir, join(config.dataDir, 'custom-tools')]) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      results.fixed.push(`Created missing directory: ${dir}`);
    }
  }

  // 2. Validate custom tools (broken ones get quarantined by loadCustomTools)
  try {
    const { loadCustomTools } = await import('./custom-tools.js');
    const tools = await loadCustomTools();
    results.ok.push(`${tools.length} custom tool(s) loaded`);
  } catch (err) {
    results.warnings.push(`Custom tools check failed: ${err.message}`);
  }

  // 3. Clean old quarantine files (>7 days)
  if (existsSync(QUARANTINE_DIR)) {
    try {
      const { stat } = await import('node:fs/promises');
      const files = await readdir(QUARANTINE_DIR);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const file of files) {
        const filePath = join(QUARANTINE_DIR, file);
        const st = await stat(filePath);
        if (st.mtimeMs < cutoff) {
          await rm(filePath);
          results.fixed.push(`Cleaned old quarantine file: ${file}`);
        }
      }
      const remaining = files.filter(f => f.endsWith('.js')).length;
      if (remaining > 0) results.warnings.push(`${remaining} tool(s) in quarantine`);
    } catch {}
  }

  // 4. Check credential/model alignment
  for (const [role, spec] of Object.entries(config.models || {})) {
    if (!spec?.provider) continue;
    const credKey = PROVIDER_CRED[spec.provider];
    if (credKey) {
      try {
        const key = await getCredential(credKey);
        if (!key) results.warnings.push(`Model role "${role}" uses ${spec.provider} but ${credKey} is not set`);
      } catch {}
    }
  }

  return results;
}
