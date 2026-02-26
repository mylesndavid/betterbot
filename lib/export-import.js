import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const dataDir = join(homedir(), '.betterbot');

// Files/dirs always included in export
const ALWAYS_INCLUDE = [
  'config.json',
  'personality.md',
  'rules.md',
  'outfits',
  'custom-tools',
  'custom-tools-quarantine',
  'graph',
  'crons.json',
  'telegram-sessions.json',
];

// Optional — included by default, can be skipped with flags
const OPTIONAL = {
  sessions: 'sessions',
  costLog: 'cost-log.json',
  heartbeatAudit: 'heartbeat-audit.json',
};

// Never exported
const NEVER_EXPORT = new Set([
  'gateway.pid',
  'heartbeat-session-id',
  'heartbeat-state.json',
  'workspace',
]);

export async function exportState(opts = {}) {
  const {
    output,
    sessions = true,
  } = opts;

  if (!existsSync(dataDir)) {
    throw new Error(`Data directory not found: ${dataDir}`);
  }

  // Build file list
  const entries = [];

  for (const name of ALWAYS_INCLUDE) {
    const full = join(dataDir, name);
    if (existsSync(full)) entries.push(name);
  }

  // Optional entries (sessions included by default)
  if (sessions && existsSync(join(dataDir, OPTIONAL.sessions))) {
    entries.push(OPTIONAL.sessions);
  }
  if (existsSync(join(dataDir, OPTIONAL.costLog))) {
    entries.push(OPTIONAL.costLog);
  }
  if (existsSync(join(dataDir, OPTIONAL.heartbeatAudit))) {
    entries.push(OPTIONAL.heartbeatAudit);
  }

  if (entries.length === 0) {
    throw new Error('Nothing to export — data directory is empty');
  }

  // Create temp staging dir
  const stamp = Date.now();
  const stagingDir = join(dataDir, `.export-staging-${stamp}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    // Copy files preserving structure
    for (const entry of entries) {
      const src = join(dataDir, entry);
      const dest = join(stagingDir, entry);
      const stat = statSync(src);
      if (stat.isDirectory()) {
        cpSync(src, dest, { recursive: true });
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
      }
    }

    // Write manifest
    const manifest = {
      version: 1,
      exportDate: new Date().toISOString(),
      files: entries,
      sessionsIncluded: sessions && existsSync(join(dataDir, OPTIONAL.sessions)),
    };
    writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Determine output path
    const date = new Date().toISOString().slice(0, 10);
    const outputPath = output || join(homedir(), 'Desktop', `betterbot-export-${date}.zip`);

    // Remove existing zip if present
    if (existsSync(outputPath)) rmSync(outputPath);

    // Create zip
    execSync(`zip -r "${outputPath}" .`, { cwd: stagingDir, stdio: 'pipe' });

    console.log(`\x1b[32m✓\x1b[0m Exported to: ${outputPath}`);
    console.log(`  Files: ${entries.join(', ')}`);
    if (!sessions) console.log('  (sessions excluded)');

    return outputPath;
  } finally {
    // Clean up staging dir
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function importState(zipPath) {
  if (!zipPath || !existsSync(zipPath)) {
    throw new Error(`File not found: ${zipPath}`);
  }

  // Extract to temp dir
  const stamp = Date.now();
  const extractDir = join(dataDir, `.import-extract-${stamp}`);
  // Ensure parent exists (dataDir might not exist on fresh machine)
  mkdirSync(extractDir, { recursive: true });

  try {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });

    // Validate manifest
    const manifestPath = join(extractDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error('Invalid backup: missing manifest.json');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // Back up existing data dir if it has content
    if (existsSync(dataDir) && readdirSync(dataDir).some(f => !f.startsWith('.import-') && !f.startsWith('.export-'))) {
      const backupDir = `${dataDir}-backup-${stamp}`;
      console.log(`  Backing up existing data to: ${backupDir}`);
      cpSync(dataDir, backupDir, { recursive: true });
    }

    // Copy extracted files into data dir
    mkdirSync(dataDir, { recursive: true });
    const restored = [];

    for (const entry of manifest.files) {
      const src = join(extractDir, entry);
      if (!existsSync(src)) continue;

      const dest = join(dataDir, entry);
      const stat = statSync(src);
      if (stat.isDirectory()) {
        // Remove existing dir first to avoid stale files
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        cpSync(src, dest, { recursive: true });
      } else {
        cpSync(src, dest);
      }
      restored.push(entry);
    }

    // Summary
    console.log(`\x1b[32m✓\x1b[0m Restored ${restored.length} items from backup`);
    console.log(`  ${restored.join(', ')}`);
    console.log(`\n  Export date: ${manifest.exportDate}`);

    if (manifest.sessionsIncluded) {
      console.log('  Sessions: included');
    }

    // Check vault path
    const configPath = join(dataDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (cfg.vault && !existsSync(cfg.vault)) {
          console.log(`\n\x1b[33m⚠\x1b[0m  Vault path not found on this machine: ${cfg.vault}`);
          console.log('  Run \x1b[1mbetterbot init\x1b[0m to update it.');
        }
      } catch {}
    }

    console.log(`\n\x1b[33m⚠\x1b[0m  Credentials are not included in backups (stored in macOS Keychain).`);
    console.log('  Run \x1b[1mbetterbot creds set <key> <value>\x1b[0m to re-enter your API keys.');

    return restored;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
