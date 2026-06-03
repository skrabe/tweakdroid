// Shared contract for the tweakdroid TUI: htm renderer, paths, config I/O,
// the ~/.factory custom-model reader, and a runner for the CLI engine.
import { createElement } from 'react';
import htm from 'htm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const html = htm.bind(createElement);

const home = os.homedir();
export const TWEAKDROID_DIR = path.join(home, '.tweakdroid');
export const ROUTER_MAP_FILE = path.join(TWEAKDROID_DIR, 'router-byok-map.json');
export const FLAGS_FILE = path.join(TWEAKDROID_DIR, 'feature-flags.json');
export const FACTORY_DIR = path.join(home, '.factory');
const ENGINE = fileURLToPath(new URL('../index.mjs', import.meta.url));

export const theme = {
  accent: 'cyan',
  dim: 'gray',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
};

// Factory Router candidate labels (the ids the router resolves to) + their role.
// The map sends each of these to one of the user's `custom:` models.
export const ROUTER_TIERS = [
  { key: 'claude-opus-4-7', label: 'Frontier', help: 'hardest work, correctness' },
  { key: 'kimi-k2.6', label: 'Mid', help: 'moderately complex' },
  { key: 'minimax-m2.7', label: 'Routine', help: 'simple / mechanical / search' },
  { key: 'gpt-5.4-mini', label: 'Classifier', help: 'scores each task, picks the tier' },
];

export function droidBinary() {
  try {
    return execFileSync('which', ['droid'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

export const readRouterMap = () => readJson(ROUTER_MAP_FILE, {}) || {};
export const writeRouterMap = (m) => writeJson(ROUTER_MAP_FILE, m);
export const readFlagsOverrides = () => readJson(FLAGS_FILE, {}) || {};
export const writeFlagsOverrides = (m) => writeJson(FLAGS_FILE, m);

// Map a custom display name -> { model, provider } from the ~/.factory configs.
function factoryModelMeta() {
  const meta = new Map();
  for (const f of ['config.json', 'settings.json']) {
    const data = readJson(path.join(FACTORY_DIR, f), null);
    if (!data) continue;
    const list =
      data.custom_models ||
      data.customModels ||
      (data.settings && data.settings.customModels) ||
      [];
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const name = m.model_display_name || m.displayName || m.name;
      if (name) meta.set(name, { model: m.model, provider: m.provider });
    }
  }
  return meta;
}

const idToLabel = (id) =>
  id
    .replace(/^custom:/, '')
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .trim();

// Authoritative custom-model ids come from droid (it loads them from ~/.factory);
// enriched with the underlying model name/provider so we can flag malformed names.
// Returns [{ id, label, model, provider, malformed }].
export function readCustomModels(binary) {
  const ids = new Set();
  if (binary) {
    try {
      const r = spawnSync(
        binary,
        ['exec', '-m', '__tweakdroid_probe__', '--list-tools'],
        { encoding: 'utf8', timeout: 30000 }
      );
      const text = (r.stdout || '') + '\n' + (r.stderr || '');
      const section = text.split(/Available custom models:/i)[1] || '';
      for (const m of section.matchAll(/custom:\S+/g)) ids.add(m[0]);
    } catch {
      // ignore; ids stays empty and the view shows a hint
    }
  }
  const meta = factoryModelMeta();
  return [...ids].map((id) => {
    const label = idToLabel(id);
    const info = meta.get(label) || {};
    return {
      id,
      label,
      model: info.model,
      provider: info.provider,
      // a real Anthropic id uses dashes (claude-opus-4-8); a dotted one
      // (claude-opus-4.8) is malformed and a proxy will reject it.
      malformed:
        typeof info.model === 'string' &&
        /^claude-[a-z0-9]+-\d+\.\d/i.test(info.model),
    };
  });
}

// Run the tweakdroid CLI engine and capture combined output.
export function runEngine(args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

// Feature-flag catalog from the live binary, merged with the user's overrides.
// Returns [{ name, displayName, statsigName, baseDefault, override, effective }].
export function readFlagCatalog(binary) {
  const res = runEngine(['--list-flags', ...(binary ? ['--binary', binary] : [])]);
  let flags = [];
  try {
    flags = JSON.parse(res.out);
  } catch {
    flags = [];
  }
  const overrides = readFlagsOverrides();
  return flags.map((f) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, f.statsigName)
      ? Boolean(overrides[f.statsigName])
      : undefined;
    return {
      ...f,
      baseDefault: f.enabled,
      override,
      effective: override === undefined ? f.enabled : override,
    };
  });
}
