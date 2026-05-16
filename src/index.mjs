#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import LIEF from 'node-lief';

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;
const TOOL_LIST_PLACEHOLDER = '{{native_tool_list}}';
const TOOL_LIST_EXPR = '${R.map((A)=>`- ${A}`).join(`\n`)}';
const PROVIDERS = ['anthropic', 'openai', 'google'];
const WARMUP_GATE_RE = /if\(\w{1,5}\(\w\)\.isCustom\)return!([01]);return!0/;

const PROMPTS = [
  {
    id: 'core_identity_base',
    file: '01-core-identity__always__all-providers.md',
    kind: 'var',
    symbol: 'pp',
    provider: 'all',
    mode: 'always',
    description:
      'Base core_identity variable. Used directly by orchestrator/worker paths and as the source for per-provider variants.',
  },
  {
    id: 'main_interactive_base',
    file: '02-main-interactive__always__all-providers.md',
    kind: 'var',
    symbol: 'RUH',
    provider: 'all',
    mode: 'interactive',
    description:
      'Base main_interactive variable. Used directly by orchestrator/worker paths and as the source for per-provider variants.',
  },
  ...PROVIDERS.map((provider) => ({
    id: `core_identity_${provider}`,
    file: `01-core-identity__always__${provider}-only.md`,
    kind: 'var',
    symbol: `twd_rv_${provider}`,
    sourceSymbol: 'pp',
    provider,
    mode: 'always',
    router: 'identity',
    description: `Provider-specific copy of rv used as the first system block for ${provider}.`,
  })),
  ...PROVIDERS.map((provider) => ({
    id: `main_interactive_${provider}`,
    file: `02-main-interactive__always__${provider}-only.md`,
    kind: 'var',
    symbol: `twd_xGH_${provider}`,
    sourceSymbol: 'RUH',
    provider,
    mode: 'interactive',
    router: 'base',
    description: `Provider-specific copy of xGH used as the normal interactive prompt for ${provider}.`,
  })),
  {
    id: 'exec_noninteractive',
    file: '03-exec-noninteractive__mode-only__all-providers.md',
    kind: 'var',
    symbol: 'v$H',
    provider: 'all',
    mode: 'exec',
    description: 'Used instead of main_interactive in non-interactive exec mode.',
  },
  {
    id: 'mission_noninteractive',
    file: '04-mission-noninteractive__mode-only__all-providers.md',
    kind: 'var',
    symbol: 'fr9',
    provider: 'all',
    mode: 'mission',
    description: 'Used instead of main_interactive in non-interactive mission mode.',
  },
  {
    id: 'openai_markdown_spec',
    file: '05-openai-markdown-spec__always__openai-only.md',
    kind: 'function',
    symbol: 'vEL',
    provider: 'openai',
    mode: 'always',
    description: 'Always appended for OpenAI provider models.',
  },
  {
    id: 'openai_cli_preference',
    file: '06-openai-cli-preference__conditional-tools__openai-only.md',
    kind: 'function',
    symbol: 'uEL',
    provider: 'openai',
    mode: 'conditional',
    dynamic: 'tool-list',
    description:
      'Appended for OpenAI only when native file tools are present; keep {{native_tool_list}} where the runtime tool list should appear.',
  },
  {
    id: 'openai_persistence_validation',
    file: '07-openai-persistence-validation__built-in-only__openai-only.md',
    kind: 'function',
    symbol: 'xEL',
    provider: 'openai',
    mode: 'built-in-only',
    description:
      'Appended only for built-in OpenAI models whose registry metadata enables persistence.',
  },
  {
    id: 'google_execute_cli_risk',
    file: '08-google-execute-cli-risk__always__google-only.md',
    kind: 'function',
    symbol: 'VEL',
    provider: 'google',
    mode: 'always',
    description: 'Always appended for Google provider models.',
  },
  {
    id: 'google_spec_mode',
    file: '09-google-spec-mode__always__google-only.md',
    kind: 'function',
    symbol: 'SEL',
    provider: 'google',
    mode: 'always',
    description: 'Always appended for Google provider models.',
  },
  {
    id: 'google_tool_usage',
    file: '10-google-tool-usage__always__google-only.md',
    kind: 'function',
    symbol: 'jEL',
    provider: 'google',
    mode: 'always',
    description: 'Always appended for Google provider models.',
  },
  {
    id: 'google_todo_tool',
    file: '11-google-todo-tool__always__google-only.md',
    kind: 'function',
    symbol: 'gEL',
    provider: 'google',
    mode: 'always',
    description: 'Always appended for Google provider models.',
  },
  {
    id: 'no_comments',
    file: '12-no-comments__built-in-only__all-providers.md',
    kind: 'function',
    symbol: 'iEL',
    provider: 'all',
    mode: 'built-in-only',
    description:
      'Appended only for built-in models whose registry metadata enables noComments (currently claude-opus-4-7).',
  },
];

function parseArgs(argv) {
  const args = {
    dir: path.join(os.homedir(), '.tweakdroid'),
    binary: null,
    output: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--extract') args.extract = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--restore') args.restore = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--binary') args.binary = argv[++i];
    else if (arg === '--dir') args.dir = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(`Usage:
  tweakdroid --extract [--binary /path/to/droid] [--dir folder]
  tweakdroid --apply [--binary /path/to/droid] [--dir folder] [--output /path/to/droid]
  tweakdroid --apply --dry-run [--binary /path/to/droid] [--dir folder]
  tweakdroid --restore [--binary /path/to/droid] [--dir folder] [--output /path/to/droid]
  tweakdroid --restore --dry-run [--binary /path/to/droid] [--dir folder]

Default folder: ~/.tweakdroid
Default binary: first droid found on PATH`);
}

function defaultDroidPath() {
  return execFileSync('which', ['droid'], { encoding: 'utf8' }).trim();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseStringPointer(buffer, offset) {
  return {
    offset: buffer.readUInt32LE(offset),
    length: buffer.readUInt32LE(offset + 4),
  };
}

function getStringPointerContent(buffer, pointer) {
  return buffer.subarray(pointer.offset, pointer.offset + pointer.length);
}

function parseOffsets(buffer) {
  return {
    byteCount: buffer.readBigUInt64LE(0),
    modulesPtr: parseStringPointer(buffer, 8),
    entryPointId: buffer.readUInt32LE(16),
    compileExecArgvPtr: parseStringPointer(buffer, 20),
    flags: buffer.readUInt32LE(28),
  };
}

function detectModuleStructSize(length) {
  const fitsNew = length % SIZEOF_MODULE_NEW === 0;
  const fitsOld = length % SIZEOF_MODULE_OLD === 0;
  if (fitsNew) return SIZEOF_MODULE_NEW;
  if (fitsOld) return SIZEOF_MODULE_OLD;
  throw new Error(`Cannot detect Bun module struct size from ${length} bytes`);
}

function parseModule(buffer, offset, moduleStructSize) {
  let pos = offset;
  const mod = {
    name: parseStringPointer(buffer, pos),
    contents: null,
    sourcemap: null,
    bytecode: null,
    moduleInfo: { offset: 0, length: 0 },
    bytecodeOriginPath: { offset: 0, length: 0 },
    encoding: 0,
    loader: 0,
    moduleFormat: 0,
    side: 0,
  };
  pos += 8;
  mod.contents = parseStringPointer(buffer, pos);
  pos += 8;
  mod.sourcemap = parseStringPointer(buffer, pos);
  pos += 8;
  mod.bytecode = parseStringPointer(buffer, pos);
  pos += 8;
  if (moduleStructSize === SIZEOF_MODULE_NEW) {
    mod.moduleInfo = parseStringPointer(buffer, pos);
    pos += 8;
    mod.bytecodeOriginPath = parseStringPointer(buffer, pos);
    pos += 8;
  }
  mod.encoding = buffer.readUInt8(pos);
  mod.loader = buffer.readUInt8(pos + 1);
  mod.moduleFormat = buffer.readUInt8(pos + 2);
  mod.side = buffer.readUInt8(pos + 3);
  return mod;
}

function parseBunDataBlob(blob) {
  const trailerStart = blob.length - BUN_TRAILER.length;
  if (!blob.subarray(trailerStart).equals(BUN_TRAILER)) {
    throw new Error('Bun trailer not found');
  }
  const offsetsStart = blob.length - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const bunOffsets = parseOffsets(
    blob.subarray(offsetsStart, offsetsStart + SIZEOF_OFFSETS)
  );
  return {
    bunData: blob,
    bunOffsets,
    moduleStructSize: detectModuleStructSize(bunOffsets.modulesPtr.length),
  };
}

function extractBunDataFromSection(sectionData) {
  const sizeU32 = sectionData.readUInt32LE(0);
  const sizeU64 = Number(sectionData.readBigUInt64LE(0));
  const u64Total = 8 + sizeU64;
  const u32Total = 4 + sizeU32;
  let headerSize;
  let size;
  if (u64Total <= sectionData.length && u64Total >= sectionData.length - 4096) {
    headerSize = 8;
    size = sizeU64;
  } else if (
    u32Total <= sectionData.length &&
    u32Total >= sectionData.length - 4096
  ) {
    headerSize = 4;
    size = sizeU32;
  } else {
    throw new Error('Cannot determine Bun section header format');
  }
  return {
    ...parseBunDataBlob(sectionData.subarray(headerSize, headerSize + size)),
    sectionHeaderSize: headerSize,
  };
}

function getBunData(binary) {
  if (binary.format === 'MachO') {
    const segment = binary.getSegment('__BUN');
    if (!segment) throw new Error('__BUN segment not found');
    const section = segment.getSection('__bun');
    if (!section) throw new Error('__bun section not found');
    return { ...extractBunDataFromSection(section.content), segment, section };
  }
  if (binary.format === 'ELF') {
    const section = binary.getSection('.bun');
    if (!section) throw new Error('.bun section not found');
    return { ...extractBunDataFromSection(section.content), segment: null, section };
  }
  throw new Error(`Unsupported binary format: ${binary.format}`);
}

function readModules(bunData, bunOffsets, moduleStructSize) {
  const modulesBytes = getStringPointerContent(bunData, bunOffsets.modulesPtr);
  const count = Math.floor(modulesBytes.length / moduleStructSize);
  const modules = [];
  for (let i = 0; i < count; i++) {
    const mod = parseModule(modulesBytes, i * moduleStructSize, moduleStructSize);
    modules.push({
      ...mod,
      index: i,
      nameBytes: getStringPointerContent(bunData, mod.name),
      contentsBytes: getStringPointerContent(bunData, mod.contents),
      sourcemapBytes: getStringPointerContent(bunData, mod.sourcemap),
      bytecodeBytes: getStringPointerContent(bunData, mod.bytecode),
      moduleInfoBytes: getStringPointerContent(bunData, mod.moduleInfo),
      bytecodeOriginPathBytes: getStringPointerContent(
        bunData,
        mod.bytecodeOriginPath
      ),
    });
  }
  return modules;
}

function findDroidModule(modules) {
  const matches = modules.filter((mod) => {
    const text = mod.contentsBytes.toString('utf8');
    return text.includes('You are Droid, an AI software engineering agent') &&
      text.includes('[buildSystemMessageBlocks]');
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one Droid JS module, found ${matches.length}`);
  }
  return matches[0];
}

const PROMPT_FINGERPRINTS = {
  core_identity_base: {
    kind: 'var',
    fingerprint: 'You are Droid, an AI software engineering agent built by Factory.',
  },
  main_interactive_base: {
    kind: 'var',
    fingerprint: 'You work within an interactive cli tool',
  },
  exec_noninteractive: {
    kind: 'var',
    fingerprint: 'You are running in non-interactive Exec Mode',
  },
  mission_noninteractive: {
    kind: 'var',
    fingerprint: 'You are running in non-interactive mission mode',
  },
  no_comments: {
    kind: 'function',
    fingerprint: 'Default to writing no comments',
  },
  openai_markdown_spec: {
    kind: 'function',
    fingerprint: '<markdown_spec>',
  },
  openai_cli_preference: {
    kind: 'function',
    fingerprint: '<cli_preference_spec>',
  },
  openai_persistence_validation: {
    kind: 'function',
    fingerprint: '<solution_persistence>',
  },
  google_execute_cli_risk: {
    kind: 'function',
    fingerprint: 'When using the execute-cli tool',
  },
  google_spec_mode: {
    kind: 'function',
    fingerprint: '<spec_mode_guidelines>',
  },
  google_tool_usage: {
    kind: 'function',
    fingerprint: '<tool_usage_rules>',
  },
  google_todo_tool: {
    kind: 'function',
    fingerprint: '<todo_tool_guidelines>',
  },
};

function findVarSymbolByFingerprint(source, fingerprint) {
  const re = new RegExp(
    `[,;{}\\s\\)](?:var\\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*["'\`]${escapeRegex(fingerprint)}`
  );
  const m = re.exec(source);
  return m ? m[1] : null;
}

function findFunctionSymbolByFingerprint(source, fingerprint) {
  const re = new RegExp(
    `function\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\([^)]*\\)\\s*\\{[^{}]*?["'\`](?:\\\\n|\\n)*${escapeRegex(fingerprint)}`
  );
  const m = re.exec(source);
  return m ? m[1] : null;
}

function deriveSymbols(source) {
  const anchor = '[buildSystemMessageBlocks]';
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error('deriveSymbols: orchestrator anchor not found');
  }
  const fnDeclRe = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;
  let lastFn = null;
  for (const m of source.slice(0, anchorIdx).matchAll(fnDeclRe)) lastFn = m;
  if (!lastFn) {
    throw new Error('deriveSymbols: orchestrator function declaration not found');
  }
  const orchestratorFn = lastFn[1];
  const orchestratorParams = lastFn[2];
  const paramMap = {};
  for (const m of orchestratorParams.matchAll(
    /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/g
  )) {
    paramMap[m[1]] = m[2];
  }
  const modelProviderParam = paramMap.modelProvider;
  const systemPromptOverrideParam = paramMap.systemPromptOverride;
  if (!modelProviderParam || !systemPromptOverrideParam) {
    throw new Error('deriveSymbols: orchestrator params not parseable');
  }
  const fnBodyStart = lastFn.index + lastFn[0].length;
  const fnBodyEnd = findBlockEnd(source, fnBodyStart - 1);
  const body = source.slice(fnBodyStart, fnBodyEnd);
  const ident = '[A-Za-z_$][A-Za-z0-9_$]*';
  const baseInitRe = new RegExp(
    `let\\s+(${ident})\\s*=\\s*\\[\\s*\\{\\s*type\\s*:\\s*"text"\\s*,\\s*text\\s*:\\s*${ident}\\s*\\}\\s*,\\s*\\{\\s*type\\s*:\\s*"text"\\s*,\\s*text\\s*:\\s*` +
      escapeRegex(systemPromptOverrideParam) +
      `\\s*\\?\\?`
  );
  const routedInitRe = new RegExp(
    `let\\s+twdP\\s*=[^,]+,\\s*(${ident})\\s*=\\s*\\[`
  );
  const initMatch = baseInitRe.exec(body) || routedInitRe.exec(body);
  if (!initMatch) {
    throw new Error('deriveSymbols: orchestrator init pattern not found');
  }
  const initLocal = initMatch[1];

  const symbols = {};
  for (const [id, fp] of Object.entries(PROMPT_FINGERPRINTS)) {
    const sym = fp.kind === 'var'
      ? findVarSymbolByFingerprint(source, fp.fingerprint)
      : findFunctionSymbolByFingerprint(source, fp.fingerprint);
    if (!sym) {
      throw new Error(
        `deriveSymbols: could not locate ${id} via fingerprint ${JSON.stringify(fp.fingerprint.slice(0, 40))}`
      );
    }
    symbols[id] = sym;
  }
  return {
    orchestratorFn,
    initLocal,
    modelProviderParam,
    systemPromptOverrideParam,
    symbols,
  };
}

function resolvePrompts(derived) {
  return PROMPTS.map((prompt) => {
    if (prompt.sourceSymbol) {
      const baseId = prompt.router === 'identity' ? 'core_identity_base' : 'main_interactive_base';
      return { ...prompt, sourceSymbol: derived.symbols[baseId] };
    }
    const sym = derived.symbols[prompt.id];
    return sym ? { ...prompt, symbol: sym } : prompt;
  });
}

function buildBaseInit(derived) {
  return `let ${derived.initLocal}=[{type:"text",text:${derived.symbols.core_identity_base}},{type:"text",text:${derived.systemPromptOverrideParam}??${derived.symbols.main_interactive_base}}];`;
}

function buildRoutedInit(derived) {
  return `let twdP=${derived.modelProviderParam}==="openai"?"openai":${derived.modelProviderParam}==="google"?"google":"anthropic",${derived.initLocal}=[{type:"text",text:twd_provider_prompts[twdP].mv},{type:"text",text:${derived.systemPromptOverrideParam}??twd_provider_prompts[twdP].mGH}];`;
}

function buildSectionData(bunBuffer, headerSize) {
  const out = Buffer.allocUnsafe(headerSize + bunBuffer.length);
  if (headerSize === 8) out.writeBigUInt64LE(BigInt(bunBuffer.length), 0);
  else out.writeUInt32LE(bunBuffer.length, 0);
  bunBuffer.copy(out, headerSize);
  return out;
}

function rebuildBunData(bunData, bunOffsets, moduleStructSize, replacement) {
  const modules = readModules(bunData, bunOffsets, moduleStructSize);
  const strings = [];
  const metadata = [];
  for (const mod of modules) {
    const moduleName = mod.nameBytes.toString('utf8');
    const contentsBytes =
      mod.index === replacement.index
        ? Buffer.from(replacement.contents, 'utf8')
        : mod.contentsBytes;
    metadata.push({
      name: mod.nameBytes,
      contents: contentsBytes,
      sourcemap: mod.sourcemapBytes,
      bytecode: mod.bytecodeBytes,
      moduleInfo: mod.moduleInfoBytes,
      bytecodeOriginPath: mod.bytecodeOriginPathBytes,
      encoding: mod.encoding,
      loader: mod.loader,
      moduleFormat: mod.moduleFormat,
      side: mod.side,
      moduleName,
    });
    strings.push(mod.nameBytes, contentsBytes, mod.sourcemapBytes, mod.bytecodeBytes);
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      strings.push(mod.moduleInfoBytes, mod.bytecodeOriginPathBytes);
    }
  }

  let offset = 0;
  const pointers = [];
  for (const value of strings) {
    pointers.push({ offset, length: value.length });
    offset += value.length + 1;
  }

  const modulesOffset = offset;
  const modulesSize = metadata.length * moduleStructSize;
  offset += modulesSize;

  const argv = getStringPointerContent(bunData, bunOffsets.compileExecArgvPtr);
  const argvOffset = offset;
  offset += argv.length + 1;

  const offsetsOffset = offset;
  offset += SIZEOF_OFFSETS;
  const trailerOffset = offset;
  offset += BUN_TRAILER.length;

  const out = Buffer.alloc(offset);
  let ptrIndex = 0;
  for (const value of strings) {
    const pointer = pointers[ptrIndex++];
    value.copy(out, pointer.offset);
    out[pointer.offset + pointer.length] = 0;
  }
  argv.copy(out, argvOffset);
  out[argvOffset + argv.length] = 0;

  const stringsPerModule = moduleStructSize === SIZEOF_MODULE_NEW ? 6 : 4;
  for (let i = 0; i < metadata.length; i++) {
    const base = i * stringsPerModule;
    let pos = modulesOffset + i * moduleStructSize;
    const writePointer = (pointer) => {
      out.writeUInt32LE(pointer.offset, pos);
      out.writeUInt32LE(pointer.length, pos + 4);
      pos += 8;
    };
    writePointer(pointers[base]);
    writePointer(pointers[base + 1]);
    writePointer(pointers[base + 2]);
    writePointer(pointers[base + 3]);
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      writePointer(pointers[base + 4]);
      writePointer(pointers[base + 5]);
    }
    out.writeUInt8(metadata[i].encoding, pos);
    out.writeUInt8(metadata[i].loader, pos + 1);
    out.writeUInt8(metadata[i].moduleFormat, pos + 2);
    out.writeUInt8(metadata[i].side, pos + 3);
  }

  out.writeBigUInt64LE(BigInt(offsetsOffset), offsetsOffset);
  out.writeUInt32LE(modulesOffset, offsetsOffset + 8);
  out.writeUInt32LE(modulesSize, offsetsOffset + 12);
  out.writeUInt32LE(bunOffsets.entryPointId, offsetsOffset + 16);
  out.writeUInt32LE(argvOffset, offsetsOffset + 20);
  out.writeUInt32LE(argv.length, offsetsOffset + 24);
  out.writeUInt32LE(bunOffsets.flags, offsetsOffset + 28);
  BUN_TRAILER.copy(out, trailerOffset);
  return out;
}

function repack(binaryPath, js, outputPath) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binaryPath);
  const { bunData, bunOffsets, moduleStructSize, sectionHeaderSize, segment, section } =
    getBunData(binary);
  const module = findDroidModule(readModules(bunData, bunOffsets, moduleStructSize));
  const newBun = rebuildBunData(bunData, bunOffsets, moduleStructSize, {
    index: module.index,
    contents: js,
  });
  const newSection = buildSectionData(newBun, sectionHeaderSize);
  if (binary.format === 'ELF') {
    patchElfInPlace(binaryPath, outputPath, Number(section.offset), newSection);
    return;
  }
  if (binary.hasCodeSignature) binary.removeSignature();
  const diff = newSection.length - Number(section.size);
  if (diff > 0) {
    const isArm64 = binary.header.cpuType === LIEF.MachO.Header.CPU_TYPE.ARM64;
    const pageSize = isArm64 ? 16384 : 4096;
    const aligned = Math.ceil(diff / pageSize) * pageSize;
    if (!binary.extendSegment(segment, aligned)) {
      throw new Error('Failed to extend __BUN segment');
    }
  }
  section.content = newSection;
  section.size = BigInt(newSection.length);
  const tmp = `${outputPath}.tmp`;
  binary.write(tmp);
  fs.chmodSync(tmp, fs.statSync(binaryPath).mode);
  fs.renameSync(tmp, outputPath);
  try {
    execSync(`codesign -s - -f "${outputPath.replaceAll('"', '\\"')}"`, {
      stdio: 'ignore',
    });
  } catch {
    console.warn('Warning: codesign failed; the patched binary may not run.');
  }
}

function patchElfInPlace(binaryPath, outputPath, sectionFileOffset, newSection) {
  const E_PHOFF = 0x20;
  const E_SHOFF = 0x28;
  const E_PHENTSIZE = 0x36;
  const E_PHNUM = 0x38;
  const E_SHENTSIZE = 0x3a;
  const E_SHNUM = 0x3c;
  const PT_LOAD = 1;
  const P_OFFSET = 0x08;
  const P_FILESZ = 0x20;
  const SH_OFFSET = 0x18;
  const SH_SIZE = 0x20;

  const orig = fs.readFileSync(binaryPath);
  const eShoff = Number(orig.readBigUInt64LE(E_SHOFF));
  const eShentsize = orig.readUInt16LE(E_SHENTSIZE);
  const eShnum = orig.readUInt16LE(E_SHNUM);
  const ePhoff = Number(orig.readBigUInt64LE(E_PHOFF));
  const ePhentsize = orig.readUInt16LE(E_PHENTSIZE);
  const ePhnum = orig.readUInt16LE(E_PHNUM);

  let sectionIdx = -1;
  let oldSectionSize = 0;
  for (let i = 0; i < eShnum; i++) {
    const entry = eShoff + i * eShentsize;
    if (Number(orig.readBigUInt64LE(entry + SH_OFFSET)) === sectionFileOffset) {
      sectionIdx = i;
      oldSectionSize = Number(orig.readBigUInt64LE(entry + SH_SIZE));
      break;
    }
  }
  if (sectionIdx === -1) {
    throw new Error('patchElfInPlace: .bun section not found in section header table');
  }

  const P_MEMSZ = 0x28;
  const P_ALIGN = 0x30;
  let segEntry = -1;
  let segOffset = -1;
  let segFilesz = 0;
  let segMemsz = 0;
  let segAlign = 0x1000;
  for (let i = 0; i < ePhnum; i++) {
    const entry = ePhoff + i * ePhentsize;
    if (orig.readUInt32LE(entry) !== PT_LOAD) continue;
    const offset = Number(orig.readBigUInt64LE(entry + P_OFFSET));
    const filesz = Number(orig.readBigUInt64LE(entry + P_FILESZ));
    if (sectionFileOffset >= offset && sectionFileOffset < offset + filesz) {
      segEntry = entry;
      segOffset = offset;
      segFilesz = filesz;
      segMemsz = Number(orig.readBigUInt64LE(entry + P_MEMSZ));
      segAlign = Number(orig.readBigUInt64LE(entry + P_ALIGN)) || 0x1000;
      break;
    }
  }
  if (segEntry === -1) {
    throw new Error('patchElfInPlace: LOAD segment for .bun not found');
  }

  for (let i = 0; i < ePhnum; i++) {
    const entry = ePhoff + i * ePhentsize;
    if (entry === segEntry) continue;
    const offset = Number(orig.readBigUInt64LE(entry + P_OFFSET));
    const filesz = Number(orig.readBigUInt64LE(entry + P_FILESZ));
    if (offset >= segOffset + segFilesz || offset + filesz <= segOffset) continue;
    throw new Error('patchElfInPlace: another segment overlaps the .bun LOAD segment; not supported');
  }
  const requiredSegSize = sectionFileOffset + newSection.length - segOffset;
  const newFilesz = Math.max(segFilesz, Math.ceil(requiredSegSize / segAlign) * segAlign);
  const newMemsz = Math.max(segMemsz, newFilesz);
  const segEnd = segOffset + newFilesz;

  const shtSize = eShnum * eShentsize;
  const finalSize = segEnd + shtSize;
  const out = Buffer.alloc(finalSize);
  orig.copy(out, 0, 0, Math.min(orig.length, segOffset + segFilesz));
  newSection.copy(out, sectionFileOffset);
  const newEnd = sectionFileOffset + newSection.length;
  const oldEnd = sectionFileOffset + oldSectionSize;
  if (newEnd < oldEnd) out.fill(0, newEnd, Math.min(oldEnd, segEnd));
  orig.copy(out, segEnd, eShoff, eShoff + shtSize);
  out.writeBigUInt64LE(BigInt(newSection.length), segEnd + sectionIdx * eShentsize + SH_SIZE);
  out.writeBigUInt64LE(BigInt(segEnd), E_SHOFF);
  out.writeBigUInt64LE(BigInt(newFilesz), segEntry + P_FILESZ);
  out.writeBigUInt64LE(BigInt(newMemsz), segEntry + P_MEMSZ);

  const tmp = `${outputPath}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.chmodSync(tmp, fs.statSync(binaryPath).mode);
  fs.renameSync(tmp, outputPath);
}

function getSource(binaryPath) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binaryPath);
  const { bunData, bunOffsets, moduleStructSize } = getBunData(binary);
  const module = findDroidModule(readModules(bunData, bunOffsets, moduleStructSize));
  return {
    source: module.contentsBytes.toString('utf8'),
    moduleName: module.nameBytes.toString('utf8'),
  };
}

function readLiteralAt(source, start) {
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote)) {
    throw new Error(`Expected string literal at ${start}`);
  }
  let i = start + 1;
  let raw = '';
  let escaped = false;
  let templateDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      raw += source.slice(i - 1, i + 1);
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      const end = findTemplateExpressionEnd(source, i + 2);
      raw += source.slice(i, end + 1);
      i = end;
      templateDepth = 0;
      continue;
    }
    if (ch === quote && templateDepth === 0) {
      return { quote, raw, literal: source.slice(start, i + 1), start, end: i + 1 };
    }
    raw += ch;
  }
  throw new Error(`Unterminated string literal at ${start}`);
}

function findTemplateExpressionEnd(source, start) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unterminated template expression');
}

function unescapeLiteral(literal) {
  return Function(`"use strict";return (${literal});`)();
}

function decodeTemplateRaw(raw) {
  return raw
    .replaceAll('\\\\', '\\')
    .replaceAll('\\`', '`')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\u2011', '‑');
}

function templateLiteral(content, dynamic) {
  let body = content;
  if (dynamic === 'tool-list') {
    body = body.replaceAll(TOOL_LIST_PLACEHOLDER, TOOL_LIST_EXPR);
  }
  const placeholder = '\0TOOL_LIST_EXPR\0';
  if (dynamic === 'tool-list') {
    body = body.replaceAll(TOOL_LIST_EXPR, placeholder);
  }
  body = body
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${');
  if (dynamic === 'tool-list') {
    body = body.replaceAll(placeholder, TOOL_LIST_EXPR);
  }
  return `\`${body}\``;
}

function locatePrompt(source, prompt) {
  if (prompt.kind === 'var') {
    const sym = prompt.sourceSymbol || prompt.symbol;
    const re = new RegExp(
      `(?<![A-Za-z0-9_$])${escapeRegex(sym)}=(?=["'\`])`
    );
    const match = re.exec(source);
    if (!match) {
      throw new Error(`Could not find var ${sym}`);
    }
    return readLiteralAt(source, match.index + match[0].length);
  }
  const fn = new RegExp(`function\\s+${escapeRegex(prompt.symbol)}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!fn) throw new Error(`Could not find function ${prompt.symbol}`);
  const bodyStart = fn.index + fn[0].length;
  const bodyEnd = findBlockEnd(source, bodyStart - 1);
  const body = source.slice(bodyStart, bodyEnd);
  const returns = [];
  for (const match of body.matchAll(/return/g)) {
    let pos = bodyStart + match.index + match[0].length;
    while (/\s/.test(source[pos])) pos++;
    if (['"', "'", '`'].includes(source[pos])) {
      returns.push(readLiteralAt(source, pos));
    }
  }
  if (returns.length === 0) {
    throw new Error(`Could not find string return in function ${prompt.symbol}`);
  }
  returns.sort((a, b) => b.literal.length - a.literal.length);
  return returns[0];
}

function findBlockEnd(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unterminated block at ${start}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptContent(source, prompt) {
  const literal = locatePrompt(source, prompt);
  let content;
  if (literal.quote === '`' && literal.raw.includes('${')) {
    content = decodeTemplateRaw(literal.raw);
  } else {
    content = unescapeLiteral(literal.literal);
  }
  if (prompt.dynamic === 'tool-list') {
    content = content.replace(TOOL_LIST_EXPR, TOOL_LIST_PLACEHOLDER);
  }
  return { ...literal, content };
}

function markdown(prompt, content, sourceHash) {
  return `---
id: ${prompt.id}
symbol: ${prompt.symbol}
provider: ${prompt.provider}
mode: ${prompt.mode}
description: ${prompt.description}
source_sha256: ${sourceHash}
---

${content}`;
}

function parseMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return { meta: {}, content: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { meta: {}, content: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx !== -1) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  let content = text.slice(end + 5);
  if (content.startsWith('\n')) content = content.slice(1);
  return { meta, content };
}

function promptDirs(dir) {
  return {
    root: dir,
    system: path.join(dir, 'system-prompts'),
    edited: path.join(dir, 'edited-prompts'),
  };
}

function readPromptFile(dir, prompt, systemOnly = false) {
  const dirs = promptDirs(dir);
  const editedFile = path.join(dirs.edited, prompt.file);
  const systemFile = path.join(dirs.system, prompt.file);
  const file = !systemOnly && fs.existsSync(editedFile) ? editedFile : systemFile;
  if (!fs.existsSync(file)) {
    const expected = systemOnly ? systemFile : `${editedFile} or ${systemFile}`;
    throw new Error(`Missing prompt file: ${expected}`);
  }
  const { content } = parseMarkdown(file);
  return content.replace(/\n$/, '');
}

function extract(binaryPath, dir) {
  const { source, moduleName } = getSource(binaryPath);
  const derived = deriveSymbols(source);
  const prompts = resolvePrompts(derived);
  const dirs = promptDirs(dir);
  fs.mkdirSync(dirs.system, { recursive: true });
  fs.mkdirSync(dirs.edited, { recursive: true });
  const manifest = {
    binary: binaryPath,
    moduleName,
    extractedAt: new Date().toISOString(),
    sourceSha256: sha256(source),
    orchestratorFn: derived.orchestratorFn,
    prompts: [],
  };
  for (const prompt of prompts) {
    const found = promptContent(source, prompt);
    const content = markdown(prompt, found.content, sha256(found.literal));
    const systemFile = path.join(dirs.system, prompt.file);
    fs.writeFileSync(systemFile, content);
    manifest.prompts.push({
      id: prompt.id,
      file: prompt.file,
      symbol: prompt.symbol,
      provider: prompt.provider,
      mode: prompt.mode,
      sourceSha256: sha256(found.literal),
    });
  }
  fs.writeFileSync(
    path.join(dirs.system, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`Extracted ${prompts.length} prompts to ${dirs.system}`);
  console.log(`Editable prompts are in ${dirs.edited}`);
}

function stripExistingProviderRouter(source, derived) {
  const marker = 'var twd_provider_prompts=';
  const start = source.indexOf(marker);
  if (start === -1) return source;
  const orchestratorMarker = `function ${derived.orchestratorFn}`;
  const end = source.indexOf(orchestratorMarker, start);
  if (end === -1) {
    throw new Error(
      `Found tweakdroid provider router but not following ${orchestratorMarker}`
    );
  }
  return source.slice(0, start) + source.slice(end);
}

function applyProviderRouter(source, dir, results, systemOnly, derived, prompts) {
  const baseInit = buildBaseInit(derived);
  const routedInit = buildRoutedInit(derived);
  const routerPrompts = prompts.filter((prompt) => prompt.router);
  const originalIdentity = promptContent(source, {
    kind: 'var',
    symbol: derived.symbols.core_identity_base,
  }).content.replace(/\n$/, '');
  const originalBase = promptContent(source, {
    kind: 'var',
    symbol: derived.symbols.main_interactive_base,
  }).content.replace(/\n$/, '');
  const providerPrompts = {};

  for (const provider of PROVIDERS) {
    const identityPrompt = routerPrompts.find(
      (prompt) => prompt.router === 'identity' && prompt.provider === provider
    );
    const basePrompt = routerPrompts.find(
      (prompt) => prompt.router === 'base' && prompt.provider === provider
    );
    providerPrompts[provider] = {
      mv: readPromptFile(dir, identityPrompt, systemOnly),
      mGH: readPromptFile(dir, basePrompt, systemOnly),
    };
    results.push({
      id: identityPrompt.id,
      file: identityPrompt.file,
      before: originalIdentity.length,
      after: providerPrompts[provider].mv.length,
    });
    results.push({
      id: basePrompt.id,
      file: basePrompt.file,
      before: originalBase.length,
      after: providerPrompts[provider].mGH.length,
    });
  }

  const differs = PROVIDERS.some(
    (provider) =>
      providerPrompts[provider].mv !== originalIdentity ||
      providerPrompts[provider].mGH !== originalBase
  );
  let next = stripExistingProviderRouter(source, derived);

  const orchestratorMarker = `function ${derived.orchestratorFn}`;
  const csTStart = next.indexOf(orchestratorMarker);
  if (csTStart === -1) {
    throw new Error(`Could not find ${orchestratorMarker}`);
  }
  if (!differs) {
    const routedIndex = next.indexOf(routedInit, csTStart);
    if (routedIndex !== -1) {
      next =
        next.slice(0, routedIndex) +
        baseInit +
        next.slice(routedIndex + routedInit.length);
    }
    return next;
  }
  let init = baseInit;
  let initIndex = next.indexOf(init, csTStart);
  if (initIndex === -1) {
    init = routedInit;
    initIndex = next.indexOf(init, csTStart);
  }
  if (initIndex === -1) {
    throw new Error(
      `Could not find ${derived.orchestratorFn} base prompt initialization`
    );
  }
  const providerEntries = PROVIDERS.map(
    (provider) =>
      `${provider}:{mv:${templateLiteral(
        providerPrompts[provider].mv,
        null
      )},mGH:${templateLiteral(providerPrompts[provider].mGH, null)}}`
  ).join(',');
  const objectLiteral = `var twd_provider_prompts={${providerEntries}};`;
  next =
    next.slice(0, csTStart) +
    objectLiteral +
    next.slice(csTStart, initIndex) +
    routedInit +
    next.slice(initIndex + init.length);
  return next;
}

function applyWarmupGate(source, enabled) {
  const match = WARMUP_GATE_RE.exec(source);
  if (!match) {
    return { source, before: null, after: null, skipped: true };
  }
  const target = enabled ? '0' : '1';
  if (match[1] === target) {
    return { source, before: match[0], after: match[0] };
  }
  const replacement = match[0].replace(
    `return!${match[1]};return!0`,
    `return!${target};return!0`
  );
  return {
    source:
      source.slice(0, match.index) +
      replacement +
      source.slice(match.index + match[0].length),
    before: match[0],
    after: replacement,
  };
}

function apply(binaryPath, dir, outputPath, dryRun, restore) {
  const { source } = getSource(binaryPath);
  const derived = deriveSymbols(source);
  const prompts = resolvePrompts(derived);
  let next = source;
  const results = [];
  for (const prompt of prompts) {
    if (prompt.router) continue;
    const content = readPromptFile(dir, prompt, restore);
    const existing = promptContent(next, prompt);
    const edited = content;
    const original = existing.content.replace(/\n$/, '');
    if (edited === original) {
      results.push({
        id: prompt.id,
        file: prompt.file,
        before: existing.literal.length,
        after: existing.literal.length,
      });
      continue;
    }
    const current = locatePrompt(next, prompt);
    const replacement = templateLiteral(edited, prompt.dynamic);
    next = next.slice(0, current.start) + replacement + next.slice(current.end);
    results.push({
      id: prompt.id,
      file: prompt.file,
      before: current.literal.length,
      after: replacement.length,
    });
  }
  next = applyProviderRouter(next, dir, results, restore, derived, prompts);
  const warmup = applyWarmupGate(next, !restore);
  next = warmup.source;
  if (warmup.skipped) {
    results.push({
      id: 'warmup_gate',
      file: '(binary patch: warmup gate not present in this droid version; skipped)',
      before: 0,
      after: 0,
    });
  } else {
    results.push({
      id: 'warmup_gate',
      file: `(binary patch: warmup ${restore ? 'disabled' : 'enabled'} for BYOK)`,
      before: warmup.before,
      after: warmup.after,
    });
  }
  const changed = next !== source;
  if (dryRun) {
    console.log(changed ? 'Dry run: source would change.' : 'Dry run: no changes.');
    for (const r of results) {
      const before = typeof r.before === 'string' ? r.before.length : r.before;
      const after = typeof r.after === 'string' ? r.after.length : r.after;
      console.log(`${r.file}: ${before} -> ${after}`);
    }
    return;
  }
  if (!changed) {
    console.log(
      restore
        ? 'No restore needed; binary already matches system-prompts.'
        : 'No prompt changes to apply.'
    );
    return;
  }
  if (!outputPath || outputPath === binaryPath) {
    outputPath = binaryPath;
  }
  repack(binaryPath, next, outputPath);
  console.log(
    restore
      ? `Restored system prompts to ${outputPath}`
      : `Applied prompt changes to ${outputPath}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const actions = [args.extract, args.apply, args.restore].filter(Boolean).length;
  if (args.help || actions !== 1) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const binary = path.resolve(args.binary || defaultDroidPath());
  const dir = path.resolve(args.dir);
  if (args.extract) extract(binary, dir);
  if (args.apply || args.restore) {
    apply(
      binary,
      dir,
      args.output && path.resolve(args.output),
      args.dryRun,
      Boolean(args.restore)
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
