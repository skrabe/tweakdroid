// Shared contract for the tweakdroid TUI: htm renderer, paths, config I/O,
// the ~/.factory custom-model reader, and a runner for the CLI engine.
import { createElement } from 'react';
import htm from 'htm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const html = htm.bind(createElement);

const home = os.homedir();
// The TUI honors the same --dir and --binary arguments as the CLI.
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};
export const TWEAKDROID_DIR = path.resolve(argValue('--dir') ?? path.join(home, '.tweakdroid'));
const BINARY_ARG = argValue('--binary');
export const ROUTER_MAP_FILE = path.join(TWEAKDROID_DIR, 'router-byok-map.json');
export const FLAGS_FILE = path.join(TWEAKDROID_DIR, 'feature-flags.json');
export const UNHIDE_FILE = path.join(TWEAKDROID_DIR, 'unhide.json');
export const FACTORY_DIR = path.join(home, '.factory');
const ENGINE = fileURLToPath(new URL('../index.mjs', import.meta.url));

export const theme = {
  accent: 'cyan',
  dim: 'gray',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
};

// Auto Model labels Droid 0.249.0 emits; used only when `tweakdroid
// --list-router-labels` cannot read them from the binary.
const DEFAULT_ROUTER_LABELS = {
  candidates: [
    'claude-opus-5-5', 'gpt-6.1-sol', 'kimi-k3', 'glm-5.3', 'gpt-6-luna', 'deepseek-v4.1-flash', 'minimax-m3',
  ],
  classifiers: [
    'gpt-5.4-mini-fast', 'gpt-5.4-mini', 'gpt-6-luna', 'gpt-5.6-luna', 'claude-haiku-4-5-20251001', 'glm-5.3',
    'kimi-k3', 'deepseek-v4.1-flash', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol',
    'claude-opus-5-5', 'claude-opus-5',
  ],
  fastCandidates: ['claude-opus-5-5-fast', 'gpt-6.1-sol-ultrafast', 'gpt-6-luna-fast'],
};

// Router rows for the Model Router view. Each row maps one or more Factory
// Router labels to a single `custom:` model: one row for the classifier (every
// classifier label Droid tries before it reaches a candidate model), one row
// per candidate, and one row per leftover map key from older Droid versions.
// Auto Model labels from the binary: candidates, the ordered classifier list,
// and classifierKeys (the classifier labels Droid can try before it reaches a
// label that is also a candidate).
export async function readRouterLabels(binary) {
  let labels = DEFAULT_ROUTER_LABELS;
  if (binary) {
    const res = await runEngineAsync(['--list-router-labels', '--binary', binary]);
    try {
      const parsed = JSON.parse(res.out);
      if (parsed.candidates && parsed.classifiers) labels = parsed;
    } catch {
      // keep the defaults
    }
  }
  const firstCandidate = labels.classifiers.findIndex((id) => labels.candidates.includes(id));
  const classifierKeys = labels.classifiers.slice(0, firstCandidate === -1 ? undefined : firstCandidate);
  return { ...labels, classifierKeys };
}

export async function routerRows(binary, map) {
  const labels = await readRouterLabels(binary);
  const { candidates, classifierKeys } = labels;
  const rows = [
    ...(classifierKeys.length > 0
      ? [{ label: 'Classifier', keys: classifierKeys, help: 'scores each turn; Droid uses the first of these labels the account may use' }]
      : []),
    ...candidates.map((id) => ({
      label: id,
      keys: [id],
      help: labels.classifiers[0] === id ? 'Auto Model candidate and first classifier choice' : 'Auto Model candidate',
    })),
  ];
  for (const id of labels.fastCandidates ?? []) {
    if (rows.some((r) => r.keys.includes(id))) continue;
    rows.push({ label: id, keys: [id], help: 'candidate of the auto-fast model (only with the alloy_fast flag)' });
  }
  const known = new Set(rows.flatMap((r) => r.keys));
  for (const key of Object.keys(map)) {
    if (!known.has(key)) rows.push({ label: key, keys: [key], help: 'not emitted by this Droid; kept for older versions', legacy: true });
  }
  return rows;
}

export function droidBinary() {
  if (BINARY_ARG) {
    if (fs.existsSync(BINARY_ARG)) return path.resolve(BINARY_ARG);
    // Never fall back to the droid on PATH when a specific binary was asked for.
    console.error(`tweakdroid: --binary ${BINARY_ARG} does not exist`);
    process.exit(1);
  }
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
// Flag values Droid last cached from Factory (~/.factory/cache/feature-flags.json).
export const readCachedServerFlags = () =>
  readJson(path.join(process.env.FACTORY_HOME_OVERRIDE || home, '.factory', 'cache', 'feature-flags.json'), {})?.flags || {};
export const writeFlagsOverrides = (m) => writeJson(FLAGS_FILE, m);

// Force (true/false) or stop forcing (undefined) one flag, re-reading the file
// so concurrent edits to other flags survive.
export function setFlagOverride(name, value) {
  const current = readFlagsOverrides();
  if (value === undefined) delete current[name];
  else current[name] = value;
  writeFlagsOverrides(current);
  return current;
}

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
export async function readCustomModels(binary) {
  const ids = new Set();
  if (binary) {
    const r = await capture(binary, ['exec', '-m', '__tweakdroid_probe__', '--list-tools'], 30000);
    const section = r.out.split(/Available custom models:/i)[1] || '';
    for (const m of section.matchAll(/custom:\S+/g)) ids.add(m[0]);
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

// Run a command without blocking the event loop (so Ink keeps rendering and
// keystrokes typed meanwhile are not replayed later); resolves with the exit
// code and combined output, never rejects.
function capture(cmd, args, timeout = 0) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 1, out: '' });
      return;
    }
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => {});
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.trim() });
    });
  });
}

export const runEngineAsync = (args) => capture(process.execPath, [ENGINE, ...args, '--dir', TWEAKDROID_DIR]);


// Feature-flag catalog from the live binary, merged with the user's overrides.
// Returns [{ name, displayName, statsigName, baseDefault, server, override, effective }]
// (server: the value Droid last cached from Factory, or null).
export async function readFlagCatalog(binary) {
  const res = await runEngineAsync(['--list-flags', ...(binary ? ['--binary', binary] : [])]);
  let flags;
  try {
    flags = JSON.parse(res.out);
  } catch {
    // Surface the engine's own message (e.g. an invalid feature-flags.json).
    throw new Error(res.out.split('\n').find((l) => l.trim()) || 'tweakdroid --list-flags printed nothing');
  }
  const overrides = readFlagsOverrides();
  return flags.map((f) => {
    const override = typeof overrides[f.statsigName] === 'boolean' ? overrides[f.statsigName] : undefined;
    const server = typeof f.server === 'boolean' ? f.server : null;
    return {
      ...f,
      baseDefault: f.enabled,
      server,
      override,
      effective: override ?? server ?? f.enabled,
    };
  });
}
