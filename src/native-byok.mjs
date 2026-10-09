// Droid's native "Auto Model Full BYOK" (Statsig flag alloy_byok).
//
// With the flag on, Droid's router looks for, per Auto Model label (a built-in
// model id such as "claude-opus-5"), the first custom model in settings that has
// `useInRouter: true` and `baseModelId: <label>`, and uses it instead of the
// Factory-hosted model, for both candidates and the classifier. The lookup only
// runs when the merged model policy has `allowFactoryRouterByok: true`;
// `factoryRouterByokOnly: true` additionally drops every label without a BYOK
// model (so nothing falls through to Factory's billed endpoint).
//
// This module reads and edits those settings fields in ~/.factory/settings.json.
// A custom model holds one baseModelId, so a model serving several labels needs
// one copy per extra label; copies tweakdroid adds are recorded in
// ~/.tweakdroid/native-byok.json so unassigning removes exactly those.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { factoryDir, readFactorySettings, updateFactorySettings, withSettingsLock } from './factory-settings.mjs';

export const POLICY_KEYS = ['allowFactoryRouterByok', 'factoryRouterByokOnly'];
const stateFile = (dir) => path.join(dir ?? path.join(os.homedir(), '.tweakdroid'), 'native-byok.json');

// Copies tweakdroid added: [{ id, label, source }]. An unreadable state file
// is an error, not "no copies", so a copy is never orphaned silently.
function readState(dir) {
  const file = stateFile(dir);
  if (!fs.existsSync(file)) return { copies: [] };
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${file}: ${error.message}; fix or delete it (it lists the router copies tweakdroid added to settings.json)`);
  }
  const copies = (Array.isArray(obj?.copies) ? obj.copies : [])
    .map((c) => (typeof c === 'string' ? { id: c } : c))
    .filter((c) => c && typeof c.id === 'string');
  return { copies };
}

function writeState(dir, state) {
  const file = stateFile(dir);
  if (state.copies.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Droid's id for each settings entry, or null for entries Droid ignores. Droid
// drops entries without a string model and provider, without a baseUrl (or
// bedrock block), or with a placeholder API key, then names the rest
// custom:<display name with whitespace runs as "-">-<n>, n counting earlier
// kept entries with that name, unless the entry has an explicit id.
const slug = (name) => name.trim().replace(/\s+/g, '-');
const PLACEHOLDER_KEYS = new Set(['YOUR_OPENAI_API_KEY', 'YOUR_API_KEY']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keptByDroid = (m) =>
  isObject(m) &&
  typeof m.model === 'string' &&
  typeof m.provider === 'string' &&
  (typeof m.baseUrl === 'string' || isObject(m.bedrock)) &&
  !(typeof m.apiKey === 'string' && PLACEHOLDER_KEYS.has(m.apiKey));
function customIds(list) {
  const seen = new Map();
  return list.map((m) => {
    if (!keptByDroid(m)) return null;
    const key = slug(typeof m.displayName === 'string' ? m.displayName : m.model);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return typeof m.id === 'string' ? m.id : `custom:${key}-${n}`;
  });
}

// The org-managed model policy Droid last cached; it outranks the user file.
function orgPolicy() {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(factoryDir(), 'cache', 'org-managed-settings.json'), 'utf8'));
    return obj?.managedSettings?.modelPolicy ?? {};
  } catch {
    return {};
  }
}

// The model policy Droid's router lookup sees: the cached org policy wins per
// key over the user file (project settings files are not read).
export function routerPolicy(data) {
  const user = isObject(data.modelPolicy) ? data.modelPolicy : {};
  const org = orgPolicy();
  return {
    allowCustomModels: org.allowCustomModels ?? user.allowCustomModels ?? true,
    allowedBaseUrls: org.allowedBaseUrls ?? user.allowedBaseUrls,
    allowFactoryRouterByok: org.allowFactoryRouterByok ?? user.allowFactoryRouterByok,
    factoryRouterByokOnly: org.factoryRouterByokOnly ?? user.factoryRouterByokOnly,
  };
}

// Droid's allowedBaseUrls match: same origin, and the path equal to or under
// the allowed path (trailing slashes ignored).
function urlAllowed(url, allowed) {
  const parse = (u) => (typeof u === 'string' && URL.canParse(u) ? new URL(u) : null);
  const trim = (p) => (p === '/' ? p : p.replace(/\/+$/, ''));
  const target = parse(url);
  if (!target) return false;
  const p = trim(target.pathname);
  return allowed.some((a) => {
    const base = parse(a);
    if (!base || base.origin !== target.origin) return false;
    const bp = trim(base.pathname);
    return bp === '/' || p === bp || p.startsWith(`${bp}/`);
  });
}

// Why Droid's router lookup would skip this entry, or null. Bedrock entries
// under an allowedBaseUrls policy cannot be checked here (Droid derives their
// endpoint from AWS settings); they count as eligible with `unverified`.
export function eligibility(entry, policy) {
  if (!policy.allowCustomModels) return { ok: false, reason: 'the model policy disables custom models (allowCustomModels: false)' };
  if (Array.isArray(policy.allowedBaseUrls) && policy.allowedBaseUrls.length > 0) {
    if (isObject(entry?.bedrock)) return { ok: true, unverified: 'Bedrock endpoint not checked against allowedBaseUrls' };
    if (!urlAllowed(entry?.baseUrl, policy.allowedBaseUrls)) {
      return { ok: false, reason: `base URL ${entry?.baseUrl ?? '(none)'} is not in the model policy's allowedBaseUrls` };
    }
  }
  return { ok: true };
}

// Current native-BYOK state. Per label: the custom model Droid would use (the
// first eligible entry with useInRouter and that baseModelId, in file order),
// plus configured entries Droid would skip and why.
export function nativeByokStatus(labels, dir) {
  const { data } = readFactorySettings();
  const list = Array.isArray(data.customModels) ? data.customModels : [];
  const ids = customIds(list);
  const state = readState(dir);
  const user = isObject(data.modelPolicy) ? data.modelPolicy : {};
  const org = orgPolicy();
  const effective = routerPolicy(data);
  const assignments = {};
  const skipped = [];
  for (const label of labels) {
    assignments[label] = null;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!ids[i] || m.useInRouter !== true || m.baseModelId !== label) continue;
      const e = eligibility(m, effective);
      if (!e.ok) {
        skipped.push({ label, id: ids[i], reason: e.reason });
        continue;
      }
      assignments[label] = {
        id: ids[i],
        displayName: m.displayName ?? m.model,
        copy: state.copies.some((c) => c.id === ids[i]),
        ...(e.unverified ? { unverified: e.unverified } : {}),
      };
      break;
    }
  }
  const known = new Set(labels);
  const strays = list
    .map((m, i) => ({ m, id: ids[i] }))
    .filter(({ m, id }) => id && (m.useInRouter === true || m.baseModelId !== undefined) && !(m.useInRouter === true && known.has(m.baseModelId)))
    .map(({ m, id }) => ({ id, baseModelId: m.baseModelId, useInRouter: m.useInRouter }));
  return {
    policy: {
      user: pick(user),
      org: pick(org),
      effective,
      scope: 'user settings.json plus the cached org policy; project .factory/settings.json files are not read',
    },
    assignments,
    skipped,
    strays,
    copies: state.copies,
  };
}

// Picker helper: { id -> eligibility } for every entry Droid would load.
export function customEligibility() {
  const { data } = readFactorySettings();
  const list = Array.isArray(data.customModels) ? data.customModels : [];
  const ids = customIds(list);
  const policy = routerPolicy(data);
  const out = {};
  list.forEach((m, i) => {
    if (ids[i]) out[ids[i]] = eligibility(m, policy);
  });
  return out;
}

const POLICY_FIELDS = ['allowCustomModels', 'allowedBaseUrls', ...POLICY_KEYS];
const pick = (obj) => Object.fromEntries(POLICY_FIELDS.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// Set or clear (value === undefined) a modelPolicy key in the user file.
export function setNativeByokPolicy(key, value) {
  if (!POLICY_KEYS.includes(key)) throw new Error(`Unknown model-policy key ${key}; expected ${POLICY_KEYS.join(' or ')}`);
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${key} must be true, false, or unset`);
  return updateFactorySettings([{ path: ['modelPolicy', key], value }]).changed;
}

// Route `label` to the custom model `customId`, as one settings write computed
// from one read. Other entries serving the label are unassigned; a model that
// already serves another label gets a copy (copies are snapshots of the source
// entry: re-assign to refresh one after editing the source model).
// The whole operation (state file and settings) runs under the settings lock,
// so concurrent tweakdroid processes cannot interleave or reuse a copy id.
export function assignNativeByok(label, customId, labels, dir) {
  if (!labels.includes(label)) throw new Error(`${label} is not an Auto Model label of this Droid build (${labels.join(', ')})`);
  if (typeof customId !== 'string' || !customId.startsWith('custom:')) throw new Error(`Expected a custom: model id, got ${customId}`);
  return withSettingsLock(() => assignLocked(label, customId, dir));
}

function assignLocked(label, customId, dir) {
  const state = readState(dir);
  const { text, data } = readFactorySettings();
  const list = Array.isArray(data.customModels) ? data.customModels : [];
  const ids = customIds(list);
  const target = ids.indexOf(customId);
  if (target === -1) throw new Error(`No custom model with id ${customId} that Droid would load in settings.json`);
  const isCopy = (i) => state.copies.some((c) => c.id === ids[i]);
  const serving = list.map((_, i) => i).filter((i) => list[i]?.baseModelId === label);
  const entry = list[target];
  const policy = routerPolicy(data);
  const fit = eligibility(entry, policy);
  if (!fit.ok) throw new Error(`Droid's router would skip ${customId}: ${fit.reason}`);
  // Already routed there (as the first match Droid would pick): nothing to do.
  const firstEligible = serving.find((i) => ids[i] && list[i].useInRouter === true && eligibility(list[i], policy).ok);
  if (entry.useInRouter === true && entry.baseModelId === label && firstEligible === target) {
    return { id: customId, copied: false, unchanged: true, removed: [] };
  }
  const source = isCopy(target) ? state.copies.find((c) => c.id === customId).source ?? customId : customId;
  const sourceIndex = ids.indexOf(source);
  const base = sourceIndex === -1 ? entry : list[sourceIndex];
  const others = serving.filter((i) => i !== target);
  // When the label goes to a copy, reuse an existing copy of the same source.
  const needsCopy = !(entry.baseModelId === undefined || entry.baseModelId === label);
  const reuse = needsCopy ? state.copies.find((c) => c.label === label && c.source === source && ids.includes(c.id)) : undefined;
  const reuseIndex = reuse ? ids.indexOf(reuse.id) : -1;
  const removeCopies = others.filter((i) => isCopy(i) && i !== reuseIndex);
  const edits = others
    .filter((i) => i !== reuseIndex)
    .filter((i) => !isCopy(i))
    .flatMap((i) => [
      { path: ['customModels', i, 'baseModelId'], value: undefined },
      { path: ['customModels', i, 'useInRouter'], value: undefined },
    ]);
  let result;
  let newCopy = null;
  if (!needsCopy) {
    edits.push({ path: ['customModels', target, 'baseModelId'], value: label }, { path: ['customModels', target, 'useInRouter'], value: true });
    result = { id: customId, copied: false };
  } else {
    if (reuse) {
      // Refresh the copy from its source (base URL, key, and so on).
      const old = list[reuseIndex];
      edits.push({
        path: ['customModels', reuseIndex],
        value: { ...base, id: reuse.id, index: old.index, displayName: old.displayName, baseModelId: label, useInRouter: true },
      });
      result = { id: reuse.id, copied: true };
    } else {
      // A fresh index above every index and id suffix in use or on record.
      const taken = new Set([...ids.filter(Boolean), ...state.copies.map((c) => c.id)]);
      const suffix = (id) => Number(/-(\d+)$/.exec(id ?? '')?.[1] ?? -1);
      let index = Math.max(list.length - 1, ...list.map((m) => (typeof m?.index === 'number' ? m.index : -1)), ...[...taken].map(suffix)) + 1;
      const displayName = `${base.displayName ?? base.model} [Auto ${label}]`;
      while (taken.has(`custom:${slug(displayName)}-${index}`)) index++;
      const id = `custom:${slug(displayName)}-${index}`;
      edits.push({ path: ['customModels', list.length], value: { ...base, id, index, displayName, baseModelId: label, useInRouter: true } });
      newCopy = { id, label, source };
      result = { id, copied: true };
    }
  }
  // Delete removed copies last, highest index first, so earlier paths stay valid.
  for (const i of [...removeCopies].sort((a, b) => b - a)) edits.push({ path: ['customModels', i], value: undefined });
  const removedIds = removeCopies.map((i) => ids[i]);
  // Record a new copy before writing settings, so a crash cannot orphan it.
  if (newCopy) writeState(dir, { copies: [...state.copies, newCopy] });
  try {
    updateFactorySettings(edits, { expectText: text, allowCustomModelGrowth: Boolean(newCopy), allowCustomModelRemoval: removedIds });
  } catch (error) {
    // Drop only our own pending record; keep whatever others recorded meanwhile.
    if (newCopy) writeState(dir, { copies: readState(dir).copies.filter((c) => c.id !== newCopy.id) });
    throw error;
  }
  const latest = readState(dir).copies.filter((c) => !removedIds.includes(c.id));
  writeState(dir, { copies: newCopy && !latest.some((c) => c.id === newCopy.id) ? [...latest, newCopy] : latest });
  return { ...result, removed: others.filter((i) => i !== reuseIndex).map((i) => ids[i]) };
}

// Stop routing `label` natively in one settings write: strip
// baseModelId/useInRouter from the user's entries serving it and delete the
// ones that are tweakdroid's own copies.
export function unassignNativeByok(label, dir) {
  return withSettingsLock(() => unassignLocked(label, dir));
}

function unassignLocked(label, dir) {
  const state = readState(dir);
  const { text, data } = readFactorySettings();
  const list = Array.isArray(data.customModels) ? data.customModels : [];
  const ids = customIds(list);
  const serving = list.map((_, i) => i).filter((i) => list[i]?.baseModelId === label);
  if (serving.length === 0) return [];
  const copies = serving.filter((i) => state.copies.some((c) => c.id === ids[i]));
  const edits = serving
    .filter((i) => !copies.includes(i))
    .flatMap((i) => [
      { path: ['customModels', i, 'baseModelId'], value: undefined },
      { path: ['customModels', i, 'useInRouter'], value: undefined },
    ]);
  for (const i of [...copies].sort((a, b) => b - a)) edits.push({ path: ['customModels', i], value: undefined });
  const removedIds = copies.map((i) => ids[i]);
  updateFactorySettings(edits, { expectText: text, allowCustomModelRemoval: removedIds });
  writeState(dir, { copies: readState(dir).copies.filter((c) => !removedIds.includes(c.id)) });
  return serving.map((i) => ids[i]);
}
