import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SERVICE = 'betterbot';
const LEGACY_SERVICE = 'betterclaw';

// In-memory cache with 5-minute TTL to avoid forking `security` on every call
const _cache = new Map(); // name → { value, expires }
const CACHE_TTL = 5 * 60 * 1000;

// macOS Keychain via `security` CLI

export async function getCredential(name) {
  // 1. Try env var first (CI / override)
  const envKey = name.toUpperCase();
  if (process.env[envKey]) return process.env[envKey];

  // 2. Check in-memory cache
  const cached = _cache.get(name);
  if (cached && Date.now() < cached.expires) return cached.value;

  // 3. Try macOS Keychain (new service name, then legacy fallback)
  for (const svc of [SERVICE, LEGACY_SERVICE]) {
    try {
      const { stdout } = await exec('security', [
        'find-generic-password',
        '-s', svc,
        '-a', name,
        '-w',
      ]);
      const value = stdout.trim();
      _cache.set(name, { value, expires: Date.now() + CACHE_TTL });
      // Migrate legacy entry to new service name
      if (svc === LEGACY_SERVICE) {
        try {
          await exec('security', ['add-generic-password', '-s', SERVICE, '-a', name, '-w', value, '-U']);
        } catch {}
      }
      return value;
    } catch { /* not found in this service */ }
  }

  _cache.set(name, { value: null, expires: Date.now() + CACHE_TTL });
  return null;
}

export async function setCredential(name, value) {
  _cache.delete(name);

  // Delete existing entry (ignore errors if not found)
  try {
    await exec('security', [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', name,
    ]);
  } catch { /* not found, fine */ }

  await exec('security', [
    'add-generic-password',
    '-s', SERVICE,
    '-a', name,
    '-w', value,
    '-U',
  ]);
}

export async function removeCredential(name) {
  _cache.delete(name);

  try {
    await exec('security', [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', name,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function listCredentials() {
  // Check which known keys are stored
  const { default: config } = await import('../config.js');
  const results = [];
  for (const key of config.credentialKeys) {
    const val = await getCredential(key);
    results.push({ name: key, configured: val !== null });
  }
  return results;
}
