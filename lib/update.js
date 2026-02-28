// Self-updater — detects install method and updates accordingly
// Git repo → git pull + npm install
// Installer (~/.betterbot/app/) → re-download from GitHub

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_URL = 'https://github.com/mylesndavid/betterbot';
const TARBALL_URL = `${REPO_URL}/archive/refs/heads/main.tar.gz`;
const INSTALL_DIR = resolve(process.env.HOME, '.betterbot', 'app');

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function findGitRoot() {
  // 1. Check if APP_ROOT itself is a git repo (dev running from source)
  try {
    run('git rev-parse --is-inside-work-tree', { cwd: APP_ROOT });
    return APP_ROOT;
  } catch {}

  // 2. If globally installed via npm link/install -g, resolve the symlink back to the source repo
  try {
    const realPath = run(`node -e "console.log(require('fs').realpathSync('${APP_ROOT}'))"`);
    if (realPath !== APP_ROOT) {
      try {
        run('git rev-parse --is-inside-work-tree', { cwd: realPath });
        return realPath;
      } catch {}
    }
  } catch {}

  // 3. Check common locations
  const home = process.env.HOME || '';
  const guesses = [
    resolve(home, 'Development/Repos/betterclaw'),
    resolve(home, 'Development/Repos/betterbot'),
    resolve(home, 'betterclaw'),
    resolve(home, 'betterbot'),
  ];
  for (const dir of guesses) {
    try {
      run('git rev-parse --is-inside-work-tree', { cwd: dir });
      // Verify it's actually the betterbot repo
      const remote = run('git remote get-url origin', { cwd: dir });
      if (remote.includes('betterbot') || remote.includes('betterclaw')) return dir;
    } catch {}
  }

  return null;
}

async function updateFromGit(repoDir) {
  console.log(`Updating from ${repoDir}...\n`);

  // Check for uncommitted changes
  const status = run('git status --porcelain', { cwd: repoDir });
  if (status) {
    console.log('⚠ You have uncommitted changes:\n');
    console.log(status);
    console.log('\nStash or commit them first, then re-run: betterbot update');
    return;
  }

  const before = run('git rev-parse HEAD', { cwd: repoDir });

  try {
    execSync('git pull --ff-only', { cwd: repoDir, stdio: 'inherit' });
  } catch {
    console.log('\n❌ Fast-forward pull failed — you may have local commits.');
    console.log('   Try: cd ' + repoDir + ' && git pull --rebase');
    return;
  }

  const after = run('git rev-parse HEAD', { cwd: repoDir });

  if (before === after) {
    console.log('\n✅ Already up to date.');
    return;
  }

  const count = run(`git rev-list --count ${before}..${after}`, { cwd: repoDir });
  const log = run(`git log --oneline ${before}..${after}`, { cwd: repoDir });
  console.log(`\n${count} new commit${count === '1' ? '' : 's'}:\n`);
  console.log(log);

  // Re-link global install so the running `betterbot` binary picks up changes
  console.log('\nRe-linking global install...');
  try {
    execSync('npm install -g .', { cwd: repoDir, stdio: 'inherit', timeout: 60000 });
    console.log('\n✅ Updated and re-linked.');
  } catch {
    console.log('\n⚠ Pull succeeded but global re-link failed.');
    console.log(`  Try manually: cd ${repoDir} && npm install -g .`);
  }
}

async function updateFromInstaller() {
  console.log('Detected standalone install — downloading latest...\n');

  const { mkdtempSync, rmSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = mkdtempSync(join(tmpdir(), 'betterbot-update-'));

  try {
    // Download tarball
    execSync(`curl -sL "${TARBALL_URL}" -o "${tmp}/bc.tgz"`, { stdio: 'inherit' });
    execSync(`tar xzf "${tmp}/bc.tgz" -C "${tmp}"`, { stdio: 'inherit' });

    const srcDir = join(tmp, 'betterbot-main');

    // Replace app files
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    cpSync(srcDir, INSTALL_DIR, { recursive: true });

    // Install deps if package.json exists
    if (existsSync(join(INSTALL_DIR, 'package.json'))) {
      console.log('Installing dependencies...');
      execSync('npm install --production', { cwd: INSTALL_DIR, stdio: 'inherit' });
    }

    // Fix permissions
    execSync(`chmod +x "${INSTALL_DIR}/bin/betterbot"`);

    // Remove quarantine (macOS)
    try { execSync(`xattr -dr com.apple.quarantine "${INSTALL_DIR}" 2>/dev/null`); } catch {}

    console.log('\n✅ Updated to latest version.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runUpdate() {
  const gitRoot = findGitRoot();

  if (gitRoot) {
    await updateFromGit(gitRoot);
  } else if (APP_ROOT.startsWith(INSTALL_DIR) || APP_ROOT === INSTALL_DIR) {
    await updateFromInstaller();
  } else {
    console.log('Could not find betterbot git repo.');
    console.log(`Running from: ${APP_ROOT}`);
    console.log('\nManual update:');
    console.log(`  curl -sL ${REPO_URL}/raw/main/install.sh | bash`);
  }
}
