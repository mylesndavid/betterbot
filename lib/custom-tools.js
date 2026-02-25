import { readdir, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import config from '../config.js';

const TOOLS_DIR = join(config.dataDir, 'custom-tools');

// Loaded custom tools (mutable — supports hot reload)
let customTools = [];

// Reserved names — built-in tools that custom tools cannot shadow.
// Updated when tools.js registers its built-ins via setBuiltinNames().
let builtinNames = new Set();

export function setBuiltinNames(names) {
  builtinNames = new Set(names);
}

export async function ensureToolsDir() {
  if (!existsSync(TOOLS_DIR)) {
    await mkdir(TOOLS_DIR, { recursive: true });
  }
}

// ── Schema validation ──────────────────────────────────────────────
// Catches the issues that make providers (especially Gemini) reject
// the entire request: missing type fields, invalid types, etc.

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function validateSchema(schema, path = 'parameters') {
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    errors.push(`${path}: must be an object`);
    return errors;
  }

  // Top-level must have type
  if (!schema.type) {
    errors.push(`${path}: missing "type" field`);
  } else if (!VALID_TYPES.has(schema.type)) {
    errors.push(`${path}: invalid type "${schema.type}" (must be one of: ${[...VALID_TYPES].join(', ')})`);
  }

  // Validate properties if present
  if (schema.properties) {
    if (typeof schema.properties !== 'object') {
      errors.push(`${path}.properties: must be an object`);
    } else {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (!prop || typeof prop !== 'object') {
          errors.push(`${path}.properties.${key}: must be an object`);
          continue;
        }
        if (!prop.type) {
          errors.push(`${path}.properties.${key}: missing "type" field`);
        } else if (!VALID_TYPES.has(prop.type)) {
          errors.push(`${path}.properties.${key}: invalid type "${prop.type}"`);
        }
        // Recurse into nested objects
        if (prop.type === 'object' && prop.properties) {
          errors.push(...validateSchema(prop, `${path}.properties.${key}`));
        }
        // Validate array items
        if (prop.type === 'array') {
          if (!prop.items) {
            errors.push(`${path}.properties.${key}: array type requires "items" field`);
          } else if (!prop.items.type) {
            errors.push(`${path}.properties.${key}.items: missing "type" field`);
          }
        }
      }
    }
  }

  // required must be an array of strings
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      errors.push(`${path}.required: must be an array`);
    } else {
      for (const r of schema.required) {
        if (typeof r !== 'string') {
          errors.push(`${path}.required: entries must be strings, got ${typeof r}`);
          break;
        }
        if (schema.properties && !schema.properties[r]) {
          errors.push(`${path}.required: "${r}" is not in properties`);
        }
      }
    }
  }

  return errors;
}

// ── Quarantine ─────────────────────────────────────────────────────
// Bad tools get moved to a quarantine dir instead of deleted, so
// the user can inspect and fix them.

const QUARANTINE_DIR = join(config.dataDir, 'custom-tools-quarantine');

async function quarantine(file, reason) {
  if (!existsSync(QUARANTINE_DIR)) {
    await mkdir(QUARANTINE_DIR, { recursive: true });
  }
  const src = join(TOOLS_DIR, file);
  const dst = join(QUARANTINE_DIR, file);
  const { rename } = await import('node:fs/promises');
  try {
    await rename(src, dst);
    // Write a .reason file so we know why
    await writeFile(dst + '.reason', `Quarantined: ${new Date().toISOString()}\n${reason}\n`, 'utf-8');
  } catch {
    // If rename fails (e.g. cross-device), just delete it
    try { await unlink(src); } catch {}
  }
  console.error(`Custom tool ${file}: quarantined — ${reason}`);
}

/**
 * Load all custom tools from ~/.betterbot/custom-tools/
 * Each file should export default { name, description, parameters, execute }
 *
 * Validates each tool on load. Bad tools are quarantined, not loaded.
 */
export async function loadCustomTools() {
  await ensureToolsDir();
  const files = await readdir(TOOLS_DIR);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  const loaded = [];
  const seenNames = new Set();

  for (const file of jsFiles) {
    try {
      const fullPath = join(TOOLS_DIR, file);
      // Use cache-busting query param so re-imports pick up changes
      const url = pathToFileURL(fullPath).href + `?t=${Date.now()}`;
      const mod = await import(url);
      const tool = mod.default;

      // ── Validation gate ──
      if (!tool?.name || !tool?.execute) {
        try { await quarantine(file, 'Missing name or execute function'); } catch {}
        continue;
      }

      // Check for collision with built-in tools
      if (builtinNames.has(tool.name)) {
        try { await quarantine(file, `Name "${tool.name}" conflicts with a built-in tool`); } catch {}
        continue;
      }

      // Check for duplicate custom tool names
      if (seenNames.has(tool.name)) {
        try { await quarantine(file, `Duplicate tool name "${tool.name}" (already loaded from another file)`); } catch {}
        continue;
      }

      // Validate parameter schema
      const params = tool.parameters || { type: 'object', properties: {}, required: [] };
      const schemaErrors = validateSchema(params);
      if (schemaErrors.length > 0) {
        try { await quarantine(file, `Invalid schema:\n${schemaErrors.join('\n')}`); } catch {}
        continue;
      }

      seenNames.add(tool.name);

      // Ensure it has the right shape
      loaded.push({
        name: tool.name,
        description: tool.description || `Custom tool: ${tool.name}`,
        parameters: params,
        execute: tool.execute,
        _source: file,
        _custom: true,
      });
    } catch (err) {
      try { await quarantine(file, `Load error: ${err.message}`); } catch {}
    }
  }

  customTools = loaded;
  return loaded;
}

/**
 * Get currently loaded custom tools
 */
export function getCustomTools() {
  return customTools;
}

/**
 * Create a new custom tool file and hot-load it.
 *
 * The tool file is a full ES module. The agent provides:
 * - imports: top-level import statements (e.g. "import { connect } from 'node:tls';")
 * - code: the async execute function body (has access to args, session, and anything imported)
 *
 * @param {string} name - Tool name (snake_case)
 * @param {string} description - What the tool does
 * @param {object} parameters - JSON Schema for parameters
 * @param {string} code - The execute function body OR a full module body.
 *   If code contains "export default", it's used as-is (full module).
 *   Otherwise it's wrapped in the standard template.
 * @param {string} [imports] - Optional import statements to put at the top of the file.
 */
export async function createCustomTool(name, description, parameters, code, imports) {
  await ensureToolsDir();

  // ── Pre-creation validation ──

  // 1. Name collision with built-ins
  if (builtinNames.has(name)) {
    throw new Error(`Cannot create tool "${name}" — it conflicts with a built-in tool. Choose a different name.`);
  }

  // 2. Name collision with existing custom tools
  const existing = customTools.find(t => t.name === name);
  if (existing) {
    throw new Error(`Tool "${name}" already exists (from ${existing._source}). Delete it first with delete_tool, or choose a different name.`);
  }

  // 3. Validate schema before writing anything
  const params = parameters || { type: 'object', properties: {}, required: [] };
  const schemaErrors = validateSchema(params);
  if (schemaErrors.length > 0) {
    throw new Error(`Invalid parameter schema:\n${schemaErrors.join('\n')}\n\nFix the schema and try again.`);
  }

  const safeName = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const filePath = join(TOOLS_DIR, `${safeName}.js`);

  let fileContent;

  if (code.includes('export default')) {
    // Full module provided — use as-is
    fileContent = `// Custom tool: ${name}\n// Created: ${new Date().toISOString()}\n\n${code}\n`;
  } else {
    // Wrap in template
    const importBlock = imports ? imports + '\n\n' : '';
    fileContent = `// Custom tool: ${name}
// Created: ${new Date().toISOString()}
// Auto-generated custom tool. Edit with care.

${importBlock}export default {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  parameters: ${JSON.stringify(parameters, null, 2)},
  async execute(args, session) {
${code.split('\n').map(line => '    ' + line).join('\n')}
  },
};
`;
  }

  await writeFile(filePath, fileContent, 'utf-8');

  // Try to load it — verify it actually works before reporting success
  try {
    const url = pathToFileURL(filePath).href + `?t=${Date.now()}`;
    const mod = await import(url);
    const tool = mod.default;

    if (!tool?.name || !tool?.execute) {
      await unlink(filePath);
      throw new Error('Tool module loaded but is missing "name" or "execute". Make sure the code exports default { name, execute, ... }');
    }

    // It works — reload all tools
    await loadCustomTools();
    return { name, path: filePath };
  } catch (err) {
    // Clean up the broken file
    try { await unlink(filePath); } catch {}
    await loadCustomTools(); // Reload without the broken file

    // Surface the ACTUAL error to the agent so it can fix it
    throw new Error(`Tool failed to load (file deleted): ${err.message}\n\nGenerated code:\n${fileContent.slice(0, 500)}`);
  }
}

/**
 * Delete a custom tool
 */
export async function deleteCustomTool(name) {
  await ensureToolsDir();
  const files = await readdir(TOOLS_DIR);

  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    try {
      const fullPath = join(TOOLS_DIR, file);
      const url = pathToFileURL(fullPath).href + `?t=${Date.now()}`;
      const mod = await import(url);
      if (mod.default?.name === name) {
        await unlink(fullPath);
        await loadCustomTools(); // Reload
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * List all custom tools with their source files
 */
export async function listCustomTools() {
  await loadCustomTools();
  return customTools.map(t => ({
    name: t.name,
    description: t.description,
    source: t._source,
  }));
}

/**
 * Read the source code of a custom tool
 */
export async function readCustomToolSource(name) {
  await ensureToolsDir();
  const files = await readdir(TOOLS_DIR);

  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const fullPath = join(TOOLS_DIR, file);
    const content = await readFile(fullPath, 'utf-8');
    if (content.includes(`name: ${JSON.stringify(name)}`)) {
      return content;
    }
  }
  return null;
}
