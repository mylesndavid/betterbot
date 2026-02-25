// Self-updater — detects install method and updates accordingly
// Git repo → git pull + npm install
// Installer (~/.betterclaw/app/) → re-download from GitHub

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_URL = 'https://github.com/devvcore/betterclaw';
const TARBALL_URL = `${REPO_URL}/archive/refs/heads/main.tar.gz`;
const INSTALL_DIR = resolve(process.env.HOME, '.betterclaw', 'app');

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function isGitRepo() {
  try {
    run('git rev-parse --is-inside-work-tree', { cwd: APP_ROOT });
    return true;
  } catch {
    return false;
  }
}

async function updateFromGit() {
  console.log('Detected git repo — pulling latest changes...\n');

  // Check for uncommitted changes
  const status = run('git status --porcelain', { cwd: APP_ROOT });
  if (status) {
    console.log('⚠ You have uncommitted changes:\n');
    console.log(status);
    console.log('\nStash or commit them first, then re-run: betterbot update');
    return;
  }

  const before = run('git rev-parse HEAD', { cwd: APP_ROOT });

  try {
    execSync('git pull --ff-only', { cwd: APP_ROOT, stdio: 'inherit' });
  } catch {
    console.log('\n❌ Fast-forward pull failed — you may have local commits.');
    console.log('   Try: cd ' + APP_ROOT + ' && git pull --rebase');
    return;
  }

  const after = run('git rev-parse HEAD', { cwd: APP_ROOT });

  // Install deps if package-lock changed
  if (existsSync(resolve(APP_ROOT, 'package.json'))) {
    const lockChanged = before !== after && (() => {
      try {
        return run(`git diff --name-only ${before} ${after}`, { cwd: APP_ROOT })
          .includes('package-lock.json');
      } catch { return true; }
    })();

    if (lockChanged) {
      console.log('\nInstalling dependencies...');
      execSync('npm install --production', { cwd: APP_ROOT, stdio: 'inherit' });
    }
  }

  if (before === after) {
    console.log('\n✅ Already up to date.');
  } else {
    const count = run(`git rev-list --count ${before}..${after}`, { cwd: APP_ROOT });
    const log = run(`git log --oneline ${before}..${after}`, { cwd: APP_ROOT });
    console.log(`\n✅ Updated (${count} new commit${count === '1' ? '' : 's'}):\n`);
    console.log(log);
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

    const srcDir = join(tmp, 'betterclaw-main');

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
  if (isGitRepo()) {
    await updateFromGit();
  } else if (APP_ROOT.startsWith(INSTALL_DIR) || APP_ROOT === INSTALL_DIR) {
    await updateFromInstaller();
  } else {
    console.log('Could not determine install method.');
    console.log(`App root: ${APP_ROOT}`);
    console.log('\nManual update options:');
    console.log(`  Git:       cd ${APP_ROOT} && git pull && npm install`);
    console.log(`  Installer: curl -sL ${REPO_URL}/raw/main/install.sh | bash`);
  }
}
