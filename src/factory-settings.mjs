// Safe edits to Droid's user settings file (~/.factory/settings.json).
//
// Droid parses this file as JSONC. Values are set with jsonc-parser's
// modify/applyEdits, which keeps other keys and comments (it may re-indent an
// object it inserts into, e.g. expand a one-line object). Keys are removed with
// a comment-aware edit that drops only the property, its own comments (on the
// lines directly above it and after it on its line), and the comma it needs.
//
// Concurrency: Droid 0.211.0 has no cross-process lock for this file. It
// re-reads the file right before each save and writes it with a temp file and
// rename (write-file-atomic). tweakdroid therefore takes its own lock file
// (against other tweakdroid processes), bases every edit on the bytes it read,
// re-checks the file (inode, size, mtime, and content) immediately before its
// own rename, aborts if anything changed, and re-reads after the rename to
// detect a writer that landed in the same instant. What remains is a window of
// microseconds between the last check and the rename in which a Droid save
// would be overwritten; edit settings with Droid closed to rule that out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jsonc from 'jsonc-parser';

export const factoryDir = () => path.join(process.env.FACTORY_HOME_OVERRIDE || os.homedir(), '.factory');
export const factorySettingsPath = () => path.join(factoryDir(), 'settings.json');

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

function parseOrThrow(text, file) {
  const errors = [];
  const data = jsonc.parse(text, errors, PARSE_OPTIONS);
  if (errors.length > 0 || !data || typeof data !== 'object' || Array.isArray(data)) {
    const first = errors[0];
    throw new Error(
      `${file} is not a valid JSON object${first ? ` (${jsonc.printParseErrorCode(first.error)} at offset ${first.offset})` : ''}; fix it by hand first`
    );
  }
  return data;
}

function snapshot(file) {
  if (!fs.existsSync(file)) return { file, text: '', data: {}, exists: false, stat: null };
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const text = fs.readFileSync(fd, 'utf8');
    return { file, text, data: parseOrThrow(text, file), exists: true, stat };
  } finally {
    fs.closeSync(fd);
  }
}

export function readFactorySettings(file = factorySettingsPath()) {
  const { text, data, exists } = snapshot(file);
  return { file, text, data, exists };
}

// ---------------------------------------------------------------------------
// Lock (tweakdroid processes only; Droid does not take it)

const held = new Map();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const STALE_MS = 60_000;

function lockIsStale(lockPath) {
  try {
    const [pid, time] = fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/).map(Number);
    if (!Number.isFinite(time) || Date.now() - time > STALE_MS) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  } catch {
    // Unreadable or vanished: judge by age.
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  }
}

// Run fn while holding <file>.twd.lock (reentrant within this process).
export function withSettingsLock(fn, file = factorySettingsPath()) {
  const lockPath = `${file}.twd.lock`;
  if (held.get(lockPath)) {
    held.set(lockPath, held.get(lockPath) + 1);
    try {
      return fn();
    } finally {
      held.set(lockPath, held.get(lockPath) - 1);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${lockPath} is held by another tweakdroid process; try again`);
      sleep(50);
    }
  }
  held.set(lockPath, 1);
  try {
    return fn();
  } finally {
    held.delete(lockPath);
    fs.rmSync(lockPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Editing

function formattingFor(text) {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

// Refuse paths whose object keys occur more than once: jsonc-parser would edit
// the first occurrence while Droid (and JSON.parse) use the last.
function assertNoDuplicateKeys(text, jsonPath, file) {
  let node = jsonc.parseTree(text, [], PARSE_OPTIONS);
  const walked = [];
  for (const key of jsonPath) {
    if (!node) return;
    if (node.type === 'object') {
      const props = (node.children ?? []).filter((p) => p.children?.[0]?.value === key);
      if (props.length > 1) {
        throw new Error(
          `${file} has the key ${JSON.stringify([...walked, key].join('.'))} ${props.length} times (Droid uses the last one); remove the duplicates by hand first`
        );
      }
      node = props[0]?.children?.[1];
    } else if (node.type === 'array' && typeof key === 'number') {
      node = node.children?.[key];
    } else {
      return;
    }
    walked.push(key);
  }
}

const isPureCommentLine = (line) => /^\s*(\/\/.*|\/\*.*\*\/\s*)$/.test(line);

// Remove the property at jsonPath, keeping comments that belong to its
// neighbours. Returns the new text (unchanged when the property is absent).
function removeProperty(text, jsonPath) {
  const root = jsonc.parseTree(text, [], PARSE_OPTIONS);
  const value = root && jsonc.findNodeAtLocation(root, jsonPath);
  const prop = value?.parent;
  if (!prop || prop.type !== 'property') return text;
  const siblings = prop.parent.children;
  const index = siblings.indexOf(prop);
  const scanFrom = (offset) => {
    const scanner = jsonc.createScanner(text, false);
    scanner.setPosition(offset);
    return scanner;
  };
  const T = jsonc.SyntaxKind;

  // Start: the key, widened to its line and the comment lines directly above
  // it when nothing else shares those lines.
  let start = prop.offset;
  let lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (text.slice(lineStart, start).trim() === '') {
    start = lineStart;
    const floor = index > 0 ? siblings[index - 1].offset + siblings[index - 1].length : prop.parent.offset + 1;
    while (start > floor) {
      const prevStart = text.lastIndexOf('\n', start - 2) + 1;
      if (prevStart < floor || !isPureCommentLine(text.slice(prevStart, start - 1))) break;
      start = prevStart;
    }
  }

  // End: the value, then a comma, then a comment on the same line, then the
  // line break when the rest of the line is empty.
  let end = prop.offset + prop.length;
  let scanner = scanFrom(end);
  let hasComma = false;
  for (let kind = scanner.scan(); kind !== T.EOF; kind = scanner.scan()) {
    if (kind === T.Trivia) continue;
    if (kind === T.CommaToken) {
      hasComma = true;
      end = scanner.getTokenOffset() + 1;
    }
    break;
  }
  scanner = scanFrom(end);
  for (let kind = scanner.scan(); kind !== T.EOF; kind = scanner.scan()) {
    if (kind === T.Trivia) continue;
    if (kind === T.LineCommentTrivia || kind === T.BlockCommentTrivia) {
      end = scanner.getTokenOffset() + scanner.getTokenLength();
      continue;
    }
    if (kind === T.LineBreakTrivia) end = scanner.getTokenOffset() + scanner.getTokenLength();
    break;
  }
  if (start === lineStart && !/\n$/.test(text.slice(start, end))) {
    // The line keeps other content after the property; keep its line start.
    start = prop.offset;
  }

  let next = text.slice(0, start) + text.slice(end);
  // A last property leaves its predecessor's comma dangling; drop that comma.
  if (!hasComma && index > 0) {
    const prev = siblings[index - 1];
    const s2 = scanFrom(prev.offset + prev.length);
    for (let kind = s2.scan(); kind !== T.EOF; kind = s2.scan()) {
      if (kind === T.Trivia || kind === T.LineBreakTrivia || kind === T.LineCommentTrivia || kind === T.BlockCommentTrivia) continue;
      if (kind === T.CommaToken && s2.getTokenOffset() < start) {
        const at = s2.getTokenOffset();
        next = next.slice(0, at) + next.slice(at + 1);
      }
      break;
    }
  }
  return next;
}

const customCount = (data) => (Array.isArray(data?.customModels) ? data.customModels.length : 0);

function applyEdit(text, jsonPath, value, formattingOptions) {
  const isObjectKey = typeof jsonPath.at(-1) === 'string';
  if (value === undefined && isObjectKey) return removeProperty(text, jsonPath);
  return jsonc.applyEdits(text, jsonc.modify(text, jsonPath, value, { formattingOptions }));
}

// Apply `edits` ([{ path: JSONPath, value }], value undefined = remove) to the
// settings file in one write. Returns { changed, data }.
// - Removing a key that leaves its parent object empty removes the parent too
//   (judged on the edited result).
// - `expectText` (the text the caller computed its edits from) makes the write
//   fail instead of clobbering a file that changed in between.
// - allowCustomModelGrowth permits adding custom models; allowCustomModelRemoval
//   lists the explicit ids of entries this edit may delete (tweakdroid's own
//   copies). Any other change to the number of custom models is refused.
export function updateFactorySettings(
  edits,
  { file = factorySettingsPath(), expectText, allowCustomModelGrowth = false, allowCustomModelRemoval = [] } = {}
) {
  return withSettingsLock(() => {
    const current = snapshot(file);
    if (expectText !== undefined && current.text !== expectText) {
      throw new Error(`${file} changed while tweakdroid was editing it; nothing was written, try again`);
    }
    let text = current.text.trim() === '' ? '{}\n' : current.text;
    const formattingOptions = formattingFor(text);
    for (const { path: jsonPath } of edits) assertNoDuplicateKeys(text, jsonPath, file);
    for (const { path: jsonPath, value } of edits) text = applyEdit(text, jsonPath, value, formattingOptions);
    for (const { path: jsonPath, value } of edits) {
      if (value !== undefined) continue;
      for (let parent = jsonPath.slice(0, -1); parent.length > 0; parent = parent.slice(0, -1)) {
        const node = getPath(jsonc.parse(text, [], PARSE_OPTIONS), parent);
        if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length > 0) break;
        text = applyEdit(text, parent, undefined, formattingOptions);
      }
    }
    if (text === current.text) return { changed: false, data: current.data };
    const errors = [];
    const data = jsonc.parse(text, errors, PARSE_OPTIONS);
    if (errors.length > 0) throw new Error('Refusing to write settings.json: the edited text would not parse');
    const before = customCount(current.data);
    const after = customCount(data);
    const removedOk =
      after < before &&
      before - after === allowCustomModelRemoval.length &&
      allowCustomModelRemoval.every(
        (id) => current.data.customModels.some((m) => m?.id === id) && !data.customModels.some((m) => m?.id === id)
      );
    if ((after < before && !removedOk) || (after > before && !allowCustomModelGrowth)) {
      throw new Error(`Refusing to write settings.json: custom model count would change from ${before} to ${after}`);
    }
    writeAtomic(file, text, current);
    return { changed: true, data };
  }, file);
}

const CHANGED = (file) => `${file} changed while tweakdroid was editing it; nothing was written, try again`;

function writeAtomic(file, text, base) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = base.stat ? base.stat.mode & 0o7777 : 0o600;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.twd-${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    // Last check right before the rename: same file object, same bytes.
    if (base.stat) {
      const now = fs.statSync(file, { throwIfNoEntry: false });
      if (!now || now.ino !== base.stat.ino || now.size !== base.stat.size || now.mtimeMs !== base.stat.mtimeMs) {
        throw new Error(CHANGED(file));
      }
      if (fs.readFileSync(file, 'utf8') !== base.text) throw new Error(CHANGED(file));
    } else if (fs.existsSync(file)) {
      throw new Error(CHANGED(file));
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dir);
    fs.closeSync(dir);
  } catch {
    // Directory fsync is best effort.
  }
  // Detect a writer that replaced the file in the same instant.
  if (fs.readFileSync(file, 'utf8') !== text) {
    throw new Error(
      `${file} was rewritten by another program right after tweakdroid saved it; check the file and run the command again`
    );
  }
}

export function getPath(obj, jsonPath) {
  let cur = obj;
  for (const key of jsonPath) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}
