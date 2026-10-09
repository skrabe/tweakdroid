#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import LIEF from 'node-lief';

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;
const PROVIDERS = ['anthropic', 'openai', 'google'];

// Prefix of the comment tagging every prompt literal tweakdroid replaced (see
// markerFor) and the comments bracketing the provider-router object.
const MARKER_PREFIX = '/*twd:';
const ROUTER_START = '/*twd-router-start*/';
const ROUTER_END = '/*twd-router-end*/';

// Every prompt is located by a fingerprint: a run of authored prose that occurs
// exactly once in the Droid bundle and sits near the start of its string
// literal (no quote characters between the literal's opening quote and the
// fingerprint). Never use minified identifiers: they differ between builds.
// Fingerprints are matched against the bundle's source text, so a prompt stored
// in a "..." literal must spell newlines as a backslash-n escape, while
// template literals contain real newlines.
const injected = (num, slug, id, fingerprint, description) => ({
  id,
  file: `${num}-${slug}__injected__all-providers.md`,
  fingerprint,
  provider: 'all',
  mode: 'injected',
  description,
});

const PROMPTS = [
  {
    id: 'core_identity_base',
    file: '01-core-identity__always__all-providers.md',
    fingerprint: 'You are Droid, an AI software engineering agent built by Factory.',
    provider: 'all',
    mode: 'always',
    description:
      'First system block for every session. Edits here change the identity variable itself, which Droid also reuses for the Auto Model classifier, image generation, and the droid-config generator.',
  },
  ...PROVIDERS.map((provider) => ({
    id: `core_identity_${provider}`,
    file: `01-core-identity__always__${provider}-only.md`,
    provider,
    mode: 'always',
    router: 'identity',
    baseId: 'core_identity_base',
    description: `First system block for ${provider} models only (falls back to the all-providers file). Applies to every mode that builds the standard system message.`,
  })),
  {
    id: 'main_interactive_base',
    file: '02-main-interactive__always__all-providers.md',
    fingerprint: "You work in the user's environment.",
    provider: 'all',
    mode: 'interactive',
    description:
      'Second system block for the TUI and ACP sessions, and the base of mission-orchestrator sessions. {{N}} placeholders are the harness, repository, and communication sections (files 58-61).',
  },
  ...PROVIDERS.map((provider) => ({
    id: `main_interactive_${provider}`,
    file: `02-main-interactive__always__${provider}-only.md`,
    provider,
    mode: 'interactive',
    router: 'main',
    baseId: 'main_interactive_base',
    description: `Main interactive prompt (TUI and ACP) for ${provider} models only; falls back to the all-providers file. Not used when a mode supplies its own prompt (exec, missions).`,
  })),
  {
    id: 'exec_noninteractive',
    file: '03-exec-noninteractive__mode-only__all-providers.md',
    fingerprint: 'You are running non-interactively.',
    provider: 'all',
    mode: 'exec',
    description:
      'Replaces the main prompt in `droid exec` (text/json/stream-json/stream-jsonrpc exec sessions) and is the base of mission-worker sessions.',
  },
  {
    id: 'mission_noninteractive',
    file: '04-mission-noninteractive__mode-only__all-providers.md',
    fingerprint: 'You are the non-interactive mission orchestrator.',
    provider: 'all',
    mode: 'mission',
    description: 'Replaces the main prompt in `droid exec --mission`.',
  },
  {
    id: 'google_execute_cli_risk',
    file: '08-google-execute-cli-risk__always__google-only.md',
    fingerprint: 'When using the execute-cli tool, you MUST write ',
    provider: 'google',
    mode: 'built-in-only',
    description:
      'Appended for built-in Gemini models (registry reminder gemini-risk-level). {{N}} vary with whether the Execute schema has riskLevel.',
  },
  {
    id: 'google_spec_mode',
    file: '09-google-spec-mode__always__google-only.md',
    fingerprint: '<spec_mode_guidelines>',
    provider: 'google',
    mode: 'built-in-only',
    description: 'Appended for built-in Gemini models (registry reminder gemini-spec-mode).',
  },
  {
    id: 'google_tool_usage',
    file: '10-google-tool-usage__always__google-only.md',
    fingerprint: '<tool_usage_rules>',
    provider: 'google',
    mode: 'built-in-only',
    description: 'Appended for built-in Gemini models (registry reminder gemini-tool-preference).',
  },
  {
    id: 'no_comments',
    file: '12-no-comments__built-in-only__all-providers.md',
    fingerprint: 'Comments: add one only when the reason behind the code is not obvious',
    provider: 'all',
    mode: 'built-in-only',
    description:
      'Appended for registry models tagged no-comments (Anthropic frontier models, including BYOK customs Droid maps onto them). `--apply` extends it to every model.',
  },
  injected('13', 'reminder-worker-resume', 'reminder_worker_resume',
    'You were interrupted mid-work. Continue where you left off.',
    'system-reminder injected when a mission worker session resumes after an interruption.'),
  injected('15', 'reminder-worker-assignment', 'reminder_worker_assignment',
    'You are a worker assigned to execute feature',
    'system-reminder assigning a feature to a mission worker.'),
  injected('16', 'startup-env', 'startup_env',
    '# The commands below ran once at session start to gather environment context.',
    'Startup environment block injected on the first turn (OS, date, model, language, directory/git info, project and personal instructions).'),
  injected('18', 'reminder-deferred-tools', 'reminder_deferred_tools',
    '\nThe tools listed below are available in this environment, but their schemas may be omitted',
    'system-reminder listing deferred tools whose schemas must be fetched before use.'),
  injected('19', 'reminder-spec-approved', 'reminder_spec_approved',
    'The user has approved your implementation plan. Spec mode has been exited and all tools are now enabled.',
    'system-reminder confirming the implementation plan was approved and all tools re-enabled.'),
  injected('20', 'reminder-spec-manual-nosave', 'reminder_spec_manual_nosave',
    'The user has manually edited and approved the specification, but it could not be saved.',
    'system-reminder: spec manually edited and approved, but the save failed.'),
  injected('21', 'reminder-spec-manual-saved', 'reminder_spec_manual_saved',
    'The user has manually edited and approved the specification. Make sure to read the updated version before proceeding.',
    'system-reminder: spec manually edited, approved and saved.'),
  injected('23', 'notification-mission-approved', 'notification_mission_approved',
    'The mission has been approved. You must now author mission artifacts in ',
    'Notification: mission approved; author artifacts in the mission directory.'),
  injected('24', 'notification-mission-paused', 'notification_mission_paused',
    'Calling start_mission_run will resume the current paused worker from where it left off.',
    'Mission-paused notification branch explaining how to resume.'),
  injected('28', 'notification-truncated-output', 'notification_truncated_output',
    'This output was truncated. The full result is saved to',
    'Reminder appended to a truncated tool result, pointing at the saved artifact file.'),
  injected('29', 'notification-ls-cwd-warning', 'notification_ls_cwd_warning',
    '<system-reminder>WARNING: ',
    'LS-tool warning that "." was replaced with an absolute path.'),
  injected('30', 'notification-tagged-dir', 'notification_tagged_dir',
    '\nUser tagged directory: ',
    'Reminder noting a directory the user @-tagged.'),
  injected('31', 'notification-dir-contents', 'notification_dir_contents',
    'Contents of directory ',
    'Reminder labelling injected directory-listing output.'),
  injected('32', 'notification-tagged-file', 'notification_tagged_file',
    '\nUser tagged file: ',
    'Reminder noting a file the user @-tagged.'),
  injected('34', 'notification-git-worktree', 'notification_git_worktree',
    'You are working inside a git worktree at ',
    'Reminder describing the active git worktree.'),
  injected('35', 'reminder-ide-active-file', 'reminder_ide_active_file',
    ' in the IDE.',
    'Reminder noting the file the user has open in the IDE. Keep the opening words: Droid recognizes old copies of this reminder by them.'),
  injected('36', 'reminder-ide-file-modified-single', 'reminder_ide_file_modified_single',
    'has been modified externally since you last accessed it.',
    'IDE reminder: a single file changed externally.'),
  injected('37', 'reminder-ide-file-modified-multi', 'reminder_ide_file_modified_multi',
    'The following files have been modified externally since you last accessed them:',
    'IDE reminder: multiple files changed externally.'),
  injected('38', 'reminder-todo-absent', 'reminder_todo_absent',
    'TodoWrite has not been called. If the task requires',
    'Mid-turn reminder nudging the model to start a todo list.'),
  injected('40', 'reminder-orchestrator-role', 'reminder_orchestrator_role',
    'REMINDER: You are the orchestrator. Your role is to plan, design worker systems, and steer execution.',
    'Reminder of the orchestrator role: plan and delegate rather than implement.'),
  injected('41', 'reminder-mission-dir', 'reminder_mission_dir',
    'MISSION CONTEXT: The current mission directory is ',
    'Reminder giving the current mission directory path.'),
  injected('42', 'notification-legacy-migration-ambiguous', 'notification_legacy_migration_ambiguous',
    'LEGACY MISSION MIGRATION: Legacy repo-root ',
    'Legacy-mission migration notice: some skills could not be auto-imported.'),
  injected('43', 'notification-legacy-migration-normal', 'notification_legacy_migration_normal',
    'LEGACY MISSION MIGRATION: This mission was created before the current artifact layout.',
    'Legacy-mission migration notice: normal migration to the current layout.'),
  injected('44', 'command-statusline-with-args', 'command_statusline_with_args',
    'Please configure the status line according to the user',
    '/statusline command injection when the user supplied instructions.'),
  injected('45', 'command-statusline-without-args', 'command_statusline_without_args',
    'The user wants to configure a custom status line.',
    '/statusline command injection with no user instructions (discovery flow).'),
  injected('47', 'command-injection-executable', 'command_injection_executable',
    'Command file: ',
    'Injection showing an executable custom command script and its output.'),
  injected('48', 'command-create-skill', 'command_create_skill',
    'Clear all previous plans and todos. Your previous task is complete. Your new task is to create a reusable skill.',
    '/create-skill instructions message.'),
  injected('49', 'command-agent-readiness', 'command_agent_readiness',
    '## User Requested Signals\nThe user asked to fix:',
    'Agent-readiness report command (branch where the user specified signals to fix).'),
  injected('50', 'command-agent-effectiveness', 'command_agent_effectiveness',
    'Generate an Agent Effectiveness Report for the currently authenticated Factory organization:',
    'Agent-effectiveness report command.'),
  injected('51', 'system-prompt-mission-orchestrator', 'system_prompt_mission_orchestrator',
    'You are the architect and manager of a multi-agent mission. You design the architecture, plan the work, design the system of workers that will build it',
    'Mission-orchestrator skill prompt.'),
  injected('54', 'system-prompt-mission-worker', 'system_prompt_mission_worker',
    'Your initial user message contains the worker skill you must invoke and follow.',
    'Mission-worker system prompt (appended to the exec prompt for worker sessions).'),
  injected('55', 'notification-acp-resource-wrapper', 'notification_acp_resource_wrapper',
    '<context ref="',
    'Wrapper that injects IDE/ACP embedded-resource text via a <context> tag.'),
  injected('56', 'other-spec-plan-not-approved', 'other_spec_plan_not_approved',
    'Plan not approved - remaining in Spec Mode. Provide feedback to refine the spec.',
    'Spec-mode "plan not approved" message.'),
  injected('57', 'system-prompt-statusline-agent', 'system_prompt_statusline_agent',
    'You are a status line setup agent for Factory Droid. Your job is to create or update the statusLine command in the user',
    'System prompt for the statusline-setup sub-agent.'),
  {
    id: 'section_harness',
    file: '58-section-harness__always__all-providers.md',
    fingerprint: '# Harness\n- Text outside tool calls is shown to the user',
    provider: 'all',
    mode: 'always',
    description:
      'Harness section interpolated into the interactive (02) and exec (03) prompts. {{1}} is the Factory-docs line (62) or, in airgap mode, the airgap rules (63).',
  },
  {
    id: 'section_repositories',
    file: '59-section-repositories__always__all-providers.md',
    fingerprint: '# Working in repositories\n',
    provider: 'all',
    mode: 'always',
    description: '"Working in repositories" section interpolated into the interactive (02) and exec (03) prompts.',
  },
  {
    id: 'section_communication',
    file: '60-section-communication__always__all-providers.md',
    fingerprint: '# Communication\n- In final responses',
    provider: 'all',
    mode: 'always',
    description:
      'Communication section interpolated into 02 and 03. When the communication_prompt_v2 flag is on, Droid swaps this exact text for file 61.',
  },
  {
    id: 'section_communication_v2',
    file: '61-section-communication-v2__flag-only__all-providers.md',
    fingerprint: '# Communication\nThese rules cover prose shown to the user',
    provider: 'all',
    mode: 'flag',
    description: 'Replacement for file 60 when the communication_prompt_v2 feature flag is on.',
  },
  {
    id: 'section_factory_docs',
    file: '62-section-factory-docs__always__all-providers.md',
    fingerprint: 'Use FetchUrl to read the Factory docs',
    provider: 'all',
    mode: 'always',
    description: 'Factory-docs line placed in the harness section (58) when airgap mode is off.',
  },
  {
    id: 'section_airgap',
    file: '63-section-airgap__airgap-only__all-providers.md',
    fingerprint: '- Airgap Mode: this machine is on an isolated network.',
    provider: 'all',
    mode: 'airgap',
    description: 'Airgap rules placed in the harness section (58) when airgap mode is on.',
  },
  {
    id: 'section_todo_planning',
    file: '64-section-todo-planning__conditional-tools__all-providers.md',
    fingerprint: '# Planning with TodoWrite',
    provider: 'all',
    mode: 'conditional',
    description: 'System block appended whenever the TodoWrite tool is available.',
  },
  {
    id: 'section_todo_batching',
    file: '65-section-todo-batching__built-in-only__all-providers.md',
    fingerprint: '# TodoWrite must share a message with real work',
    provider: 'all',
    mode: 'built-in-only',
    description: 'System block appended with TodoWrite for registry models flagged batchTodoWrite.',
  },
  {
    id: 'section_service_account',
    file: '66-section-service-account__service-only__all-providers.md',
    fingerprint: '# Service account identity',
    provider: 'all',
    mode: 'service',
    description: 'System block appended when Droid runs as an organization service account.',
  },
  injected('67', 'reminder-todo-open-items', 'reminder_todo_open_items',
    'IMPORTANT: You may be ending the turn, but the TodoWrite plan still has open items.',
    'Reminder injected when the model ends a turn while todo items are still open.'),
  injected('68', 'reminder-spec-mode-active', 'reminder_spec_mode_active',
    'Spec mode is active. Do NOT edit files',
    'First paragraph of the spec-mode reminder (read-only rules).'),
  injected('69', 'reminder-spec-mode-askuser', 'reminder_spec_mode_askuser',
    'Use the AskUser tool to gather requirements, clarify decisions',
    'Spec-mode reminder paragraph added when AskUser is available (TUI, not ACP).'),
  {
    id: 'output_style_concise',
    file: '70-output-style-concise__setting-only__all-providers.md',
    fingerprint: 'The user prefers minimal prose.',
    provider: 'all',
    mode: 'setting',
    description: 'Built-in "concise" output style, appended as the last system block when outputStyle is concise (output_style_setting flag).',
  },
  {
    id: 'subagent_contract',
    file: '71-subagent-contract__subagent-only__all-providers.md',
    fingerprint: 'Subagent contract:\n',
    provider: 'all',
    mode: 'subagent',
    description: 'Contract appended to the task prompt (user message) of every Task subagent.',
  },
  injected('72', 'reminder-available-subagents', 'reminder_available_subagents',
    'The Task tool relies on this system reminder for valid subagent_type names.',
    'system-reminder listing the subagents available to the Task tool.'),
  {
    id: 'router_classifier',
    file: '73-router-classifier__auto-model-only__all-providers.md',
    fingerprint: 'You are a task routing classifier for an AI coding agent.',
    provider: 'all',
    mode: 'auto-model',
    description: 'System prompt of the Auto Model (Factory Router) classifier that scores candidate models for each turn.',
  },
  {
    id: 'risk_classifier',
    file: '74-risk-classifier__flag-only__all-providers.md',
    fingerprint: 'You are an independent operation-risk classifier.',
    provider: 'all',
    mode: 'flag',
    description: 'System prompt of the independent command-risk classifier (independent_command_risk_classification flag).',
  },
  injected('75', 'reminder-end-feature-run', 'reminder_end_feature_run',
    'You ended your turn without calling end_feature_run',
    'Nudge sent to a mission worker that ended its turn without calling end_feature_run.'),
  injected('76', 'notification-worktree-setup-failed', 'notification_worktree_setup_failed',
    'This session runs in a new worktree whose setup script failed',
    'Notice injected when a new session worktree’s setup script failed.'),
  injected('77', 'notification-pull-failed', 'notification_pull_failed',
    'This session was started with "pull from origin" enabled, but the pull failed.',
    'Notice injected when the session’s "pull from origin" step failed.'),
  injected('78', 'notification-branch-renamed', 'notification_branch_renamed',
    'The branch this session works on has been renamed',
    'Notice injected after Droid renames the session branch to match its title.'),
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
    else if (arg === '--list-flags') args.listFlags = true;
    else if (arg === '--list-router-labels') args.listRouterLabels = true;
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
  tweakdroid --list-flags [--binary /path/to/droid]   print feature flags as JSON
  tweakdroid --list-router-labels [--binary /path/to/droid]   print Auto Model labels as JSON
  tweakdroid                     launch the interactive TUI (no args)

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

// The Droid application module, identified by code anchors rather than prompt
// text (which the user may have edited).
function findDroidModule(modules) {
  const matches = modules.filter((mod) => {
    const text = mod.contentsBytes.toString('utf8');
    return text.includes('[buildSystemMessageBlocks]') && text.includes('name:"@factory/cli"');
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one Droid JS module, found ${matches.length}`);
  }
  return matches[0];
}

function getSource(binaryPath) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binaryPath);
  const { bunData, bunOffsets, moduleStructSize } = getBunData(binary);
  const module = findDroidModule(readModules(bunData, bunOffsets, moduleStructSize));
  return { source: module.contentsBytes.toString('utf8') };
}

function readLiteralAt(source, start) {
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote)) {
    throw new Error(`Expected string literal at ${start}`);
  }
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = findTemplateExpressionEnd(source, i + 2);
      continue;
    }
    if (ch === quote) {
      return { quote, literal: source.slice(start, i + 1), start, end: i + 1 };
    }
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

function decodeTemplateText(text) {
  return Function('"use strict";return `' + text + '`;')();
}

function splitTemplateSegments(literal) {
  const body = literal.literal.slice(1, -1);
  const segments = [];
  let text = '';
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      text += '\\' + ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (literal.quote === '`' && ch === '$' && body[i + 1] === '{') {
      const end = findTemplateExpressionEnd(body, i + 2);
      segments.push({ text }, { expr: body.slice(i + 2, end) });
      text = '';
      i = end;
      continue;
    }
    text += ch;
  }
  segments.push({ text });
  return segments;
}

function templateToPlaceholders(literal) {
  const exprs = [];
  let content = '';
  for (const segment of splitTemplateSegments(literal)) {
    if (segment.expr !== undefined) {
      exprs.push(segment.expr);
      content += `{{${exprs.length}}}`;
    } else {
      content += decodeTemplateText(segment.text);
    }
  }
  return { content, exprs };
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

const IDENT = '[A-Za-z_$][\\w$]*';
const LITERAL_KEYWORDS = new Set([
  'return', 'case', 'typeof', 'void', 'in', 'of', 'yield', 'await', 'else',
  'do', 'throw', 'delete', 'instanceof', 'new',
]);
const JS_WORDS = new Set([
  ...LITERAL_KEYWORDS, 'true', 'false', 'null', 'undefined', 'this', 'function',
  'let', 'const', 'var', 'if', 'for', 'while', 'switch', 'break', 'continue',
  'try', 'catch', 'finally', 'class', 'extends', 'super', 'import', 'export',
  'default', 'with', 'debugger', 'async', 'NaN', 'Infinity',
]);

// Replace `[start, end)` spans of `source` with new text. Spans must not overlap.
function spliceAll(source, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error(`${sorted[i - 1].label} and ${sorted[i].label} resolve to overlapping text in the binary`);
    }
  }
  let out = '';
  let pos = 0;
  for (const edit of sorted) {
    out += source.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  return out + source.slice(pos);
}

function buildInterpolatedLiteral(content, exprs) {
  const body = content
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
    .replaceAll('\r', '\\r')
    .replace(/\{\{(\d+)\}\}/g, (match, n) => {
      const expr = exprs[Number(n) - 1];
      if (expr === undefined) {
        throw new Error(
          `Prompt references ${match}, but the factory literal has only ${exprs.length} interpolation slot(s).`
        );
      }
      return '${' + expr + '}';
    });
  return '`' + body + '`';
}

function literalContent(literal) {
  if (literal.quote === '`') return templateToPlaceholders(literal);
  return { content: unescapeLiteral(literal.literal), exprs: [] };
}

// True when a quote at `q` can open a string literal: it must follow an
// operator, punctuation, or keyword, not an identifier (an apostrophe inside
// prose) or a closing bracket (the end of a `${...}` inside a template).
function canOpenLiteral(source, q) {
  if (source[q - 1] === '\\') return false;
  let p = q - 1;
  while (p >= 0) {
    if (/\s/.test(source[p])) {
      p--;
      continue;
    }
    if (source[p] === '/' && source[p - 1] === '*') {
      const open = source.lastIndexOf('/*', p - 1);
      if (open === -1) break;
      p = open - 1;
      continue;
    }
    break;
  }
  if (p < 0) return true;
  const ch = source[p];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let s = p;
    while (s > 0 && /[A-Za-z0-9_$]/.test(source[s - 1])) s--;
    return LITERAL_KEYWORDS.has(source.slice(s, p + 1));
  }
  return !')]}"\'`'.includes(ch);
}

function enclosingLiteral(source, index) {
  for (let q = index - 1; q >= Math.max(0, index - 50000); q--) {
    const ch = source[q];
    if (ch !== '"' && ch !== "'" && ch !== '`') continue;
    if (!canOpenLiteral(source, q)) continue;
    let literal;
    try {
      literal = readLiteralAt(source, q);
    } catch {
      continue;
    }
    if (literal.start < index && index < literal.end) return literal;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Patch markers. A replaced prompt literal is preceded by
//   /*twd:<id>:<base64 of the factory literal>*/
// so it can be found again after its fingerprint text was edited away, and so
// the binary alone carries everything needed to restore it.

const MARKER_RE = /\/\*twd:([a-z0-9_]+):([A-Za-z0-9+/=]*)\*\//g;

const markerFor = (id, factoryLiteral) =>
  `${MARKER_PREFIX}${id}:${Buffer.from(factoryLiteral, 'utf8').toString('base64')}*/`;

function markedLiterals(source) {
  const found = [];
  for (const m of source.matchAll(MARKER_RE)) {
    const literal = readLiteralAt(source, m.index + m[0].length);
    found.push({
      id: m[1],
      factoryLiteral: Buffer.from(m[2], 'base64').toString('utf8'),
      ...literal,
      markerStart: m.index,
    });
  }
  return found;
}

function routerRegion(source) {
  const start = source.indexOf(ROUTER_START);
  if (start === -1) return null;
  const end = source.indexOf(ROUTER_END, start);
  if (end === -1) throw new Error('Found the tweakdroid router start marker without its end marker');
  return [start, end + ROUTER_END.length];
}

// Spans holding text tweakdroid inserted (replaced literals and the provider
// router object). Code patterns must never be matched inside them.
function protectedRanges(source) {
  const ranges = markedLiterals(source).map((m) => [m.markerStart, m.end]);
  const region = routerRegion(source);
  if (region) ranges.push(region);
  return ranges;
}

const insideRanges = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);

// All matches of `re` (a global regex) in source[from, to) that do not start
// inside a protected range. Indices are absolute.
function codeMatches(source, re, from = 0, to = source.length) {
  const ranges = protectedRanges(source);
  return [...source.slice(from, to).matchAll(re)]
    .map((m) => Object.assign(m, { index: m.index + from }))
    .filter((m) => !insideRanges(ranges, m.index));
}

// Locate a prompt's unpatched literal by its fingerprint, ignoring text
// tweakdroid inserted. Returns null when the fingerprint is absent.
function locateLiteral(source, prompt) {
  const ranges = protectedRanges(source);
  const hits = [];
  for (let i = source.indexOf(prompt.fingerprint); i !== -1; i = source.indexOf(prompt.fingerprint, i + 1)) {
    if (!insideRanges(ranges, i)) hits.push(i);
  }
  const label = JSON.stringify(prompt.fingerprint.slice(0, 60));
  if (hits.length === 0) return null;
  if (hits.length > 1) throw new Error(`${prompt.file}: fingerprint ${label} is not unique (${hits.length} hits)`);
  const literal = enclosingLiteral(source, hits[0]);
  if (!literal) {
    throw new Error(`${prompt.file}: no string literal encloses fingerprint ${label}; pick prose nearer the literal start`);
  }
  const content = literalContent(literal);
  if (!content.content.includes(prompt.fingerprint)) {
    throw new Error(`${prompt.file}: located a literal that does not contain the fingerprint text`);
  }
  return { ...literal, ...content };
}

// Every non-router prompt located in pristine source, keyed by id. Throws when
// two prompts resolve to overlapping text.
function locateFactoryPrompts(source) {
  const found = new Map();
  for (const prompt of PROMPTS) {
    if (prompt.router) continue;
    const literal = locateLiteral(source, prompt);
    if (literal) found.set(prompt.id, literal);
  }
  const spans = [...found].map(([id, l]) => ({ id, start: l.start, end: l.end })).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      throw new Error(`Prompts ${spans[i - 1].id} and ${spans[i].id} resolve to overlapping literals; fix their fingerprints`);
    }
  }
  return found;
}

function droidVersion(source) {
  return /name:"@factory\/cli",version:"([^"]+)"/.exec(source)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Prompt files

function markdown(prompt, found) {
  const meta = [`id: ${prompt.id}`];
  if (prompt.fingerprint) meta.push(`fingerprint: ${JSON.stringify(prompt.fingerprint)}`);
  if (prompt.baseId) meta.push(`base: ${prompt.baseId}`);
  meta.push(`provider: ${prompt.provider}`);
  meta.push(`mode: ${prompt.mode}`);
  meta.push(`description: ${prompt.description}`);
  meta.push(`source_sha256: ${sha256(found.literal)}`);
  meta.push(`content_sha256: ${sha256(found.content)}`);
  if (found.exprs.length > 0) meta.push(`interpolations: ${JSON.stringify(found.exprs)}`);
  // Always end with one newline; readPromptAt strips exactly one, so content
  // that itself ends in a newline survives the round trip.
  return `---\n${meta.join('\n')}\n---\n\n${found.content}\n`;
}

function parseMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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

function readPromptAt(file) {
  if (!fs.existsSync(file)) return null;
  const { meta, content } = parseMarkdown(file);
  return { file, meta, content: content.replace(/\n$/, '') };
}

const readEditedPrompt = (dir, prompt) => readPromptAt(path.join(promptDirs(dir).edited, prompt.file));

function readManifest(dir) {
  const file = path.join(promptDirs(dir).system, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Warn about edited prompts that match no prompt in this build, and about
// edited prompts whose factory text changed since they were written (judged
// against the binary itself). Older edited files only carry source_sha256 (the
// raw literal), so they are compared on that.
function reportOverrideHealth(dir, factory) {
  const editedDir = promptDirs(dir).edited;
  if (!fs.existsSync(editedDir)) return;
  const byFile = new Map(PROMPTS.map((p) => [p.file, p]));
  const orphans = [];
  const stale = [];
  for (const file of fs.readdirSync(editedDir).filter((f) => f.endsWith('.md')).sort()) {
    const prompt = byFile.get(file);
    const literal = prompt && factory.get(prompt.router ? prompt.baseId : prompt.id);
    if (!literal) {
      orphans.push(file);
      continue;
    }
    const { meta } = readEditedPrompt(dir, prompt);
    const current = meta.content_sha256 ? sha256(literal.content) : sha256(literal.literal);
    const recorded = meta.content_sha256 ?? meta.source_sha256;
    if (recorded && recorded !== current) stale.push(file);
  }
  if (orphans.length > 0) {
    console.warn(
      `Warning: ${orphans.length} edited prompt(s) match no prompt in this Droid build and are ignored:\n` +
        orphans.map((f) => `  - ${f}`).join('\n')
    );
  }
  if (stale.length > 0) {
    console.warn(
      `Note: the factory text behind ${stale.length} edited prompt(s) changed since they were written; review them against system-prompts/:\n` +
        stale.map((f) => `  - ${f}`).join('\n')
    );
  }
}

// ---------------------------------------------------------------------------
// Restore: undo every tweakdroid patch using only what the binary carries.

function restoreSource(source) {
  let next = spliceAll(
    source,
    markedLiterals(source).map((m) => ({ start: m.markerStart, end: m.end, text: m.factoryLiteral, label: m.id }))
  );
  if (next.includes(MARKER_PREFIX)) {
    throw new Error('This binary has tweakdroid markers from an older tweakdroid that cannot be undone in place; reinstall Droid (`droid update`) and re-apply.');
  }
  next = stripProviderRouter(next);
  next = applyNoCommentsForAll(next, false).source;
  next = applyRouterByokRemap(next, {}, false).source;
  next = applyFeatureFlagsPatch(next, {}, true).source;
  if (isPatched(next)) throw new Error('Could not remove every tweakdroid patch from this binary');
  return next;
}

function isPatched(source) {
  return (
    source.includes(MARKER_PREFIX) ||
    source.includes(ROUTER_START) ||
    source.includes('twd_provider_prompts') ||
    source.includes('let twdFF=') ||
    noCommentsWidened(source) ||
    applyRouterByokRemap(source, {}, false).patched
  );
}

// ---------------------------------------------------------------------------
// Extract

function extract(binaryPath, dir) {
  const { source: binarySource } = getSource(binaryPath);
  // A patched binary is restored in memory first, so system-prompts always
  // holds factory text.
  const source = restoreSource(binarySource);
  const version = droidVersion(source);
  const dirs = promptDirs(dir);
  fs.mkdirSync(dirs.system, { recursive: true });
  fs.mkdirSync(dirs.edited, { recursive: true });

  const found = locateFactoryPrompts(source);
  for (const [id, data] of found) {
    const rebuilt = templateToPlaceholders(readLiteralAt(buildInterpolatedLiteral(data.content, data.exprs), 0));
    if (rebuilt.content !== data.content || rebuilt.exprs.join('\0') !== data.exprs.join('\0')) {
      throw new Error(`${PROMPTS.find((p) => p.id === id).file}: extracted text does not round-trip through the patcher`);
    }
  }
  const missing = PROMPTS.filter((p) => !p.router && !found.has(p.id));

  const written = new Set();
  const manifest = {
    binary: binaryPath,
    droidVersion: version,
    extractedAt: new Date().toISOString(),
    sourceSha256: sha256(source),
    prompts: [],
    missing: missing.map((p) => p.id),
  };
  for (const prompt of PROMPTS) {
    const data = found.get(prompt.router ? prompt.baseId : prompt.id);
    if (!data) continue;
    fs.writeFileSync(path.join(dirs.system, prompt.file), markdown(prompt, data));
    written.add(prompt.file);
    manifest.prompts.push({
      id: prompt.id,
      file: prompt.file,
      provider: prompt.provider,
      mode: prompt.mode,
      sourceSha256: sha256(data.literal),
      contentSha256: sha256(data.content),
    });
  }
  // system-prompts mirrors the installed binary: drop files from older builds
  // (and the factory-literals.json older tweakdroid versions wrote).
  for (const file of fs.readdirSync(dirs.system)) {
    if ((/^\d+-.*\.md$/.test(file) && !written.has(file)) || file === 'factory-literals.json') {
      fs.rmSync(path.join(dirs.system, file));
    }
  }
  fs.writeFileSync(path.join(dirs.system, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`Extracted ${written.size} prompts from Droid ${version ?? '(unknown version)'} to ${dirs.system}`);
  console.log(`Editable prompts are in ${dirs.edited}`);
  if (missing.length > 0) {
    console.warn(
      `Warning: ${missing.length} known prompt(s) were not found in this build and were skipped (update their fingerprints if they still exist):\n` +
        missing.map((p) => `  - ${p.file}`).join('\n')
    );
  }
  reportOverrideHealth(dir, found);
}

// ---------------------------------------------------------------------------
// Provider router: per-provider copies of prompts 01 and 02.
//
// Droid builds the standard system message in one function (the one that logs
// "[buildSystemMessageBlocks]"):
//   let ...,f=H??wYR(),C=...f.replace(IYR,jDi)...,L=[{type:"text",text:_W},{type:"text",text:C}]
// where H is the mode's prompt override, wYR() renders prompt 02 (a template
// function), and _W is prompt 01. The router wraps those two expressions so the
// provider of the model being called (the function's modelProvider argument)
// picks its own text, and keeps the original expression as the ?? fallback so
// removing the router is a plain unwrap.

const ROUTER_PROVIDER = 'arguments[0]?.modelProvider';
const ROUTER_MAIN_RE = new RegExp(
  `\\(twd_provider_prompts\\.main\\(arguments\\[0\\]\\?\\.modelProvider\\)\\?\\?(${IDENT})\\(\\)\\)`,
  'g'
);
const ROUTER_IDENTITY_RE = new RegExp(
  `\\(twd_provider_prompts\\.identity\\(arguments\\[0\\]\\?\\.modelProvider\\)\\?\\?(${IDENT})\\)`,
  'g'
);

function stripProviderRouter(source) {
  const region = routerRegion(source);
  let next = region ? source.slice(0, region[0]) + source.slice(region[1]) : source;
  next = next
    .replace(ROUTER_MAIN_RE, (_, fn) => `${fn}()`)
    .replace(ROUTER_IDENTITY_RE, (_, id) => id);
  if (next.includes('twd_provider_prompts')) {
    throw new Error('Could not fully remove the tweakdroid provider router from this binary');
  }
  return next;
}

function functionBody(source, name) {
  const decls = [...source.matchAll(new RegExp(`function ${escapeRegex(name)}\\(([^)]*)\\)\\{`, 'g'))];
  if (decls.length !== 1) return null;
  const start = decls[0].index + decls[0][0].length;
  const end = findBlockEnd(source, start - 1);
  return { params: decls[0][1], start, end, body: source.slice(start, end) };
}

// The function that assembles the standard system message, found by the log
// tag it emits. Returns its declaration, body span, and prompt-override param.
function systemMessageBuilder(source) {
  const anchor = source.indexOf('[buildSystemMessageBlocks]');
  if (anchor === -1) throw new Error('System-message builder not found ([buildSystemMessageBlocks] anchor missing)');
  let decl = null;
  for (const m of source.slice(Math.max(0, anchor - 20000), anchor).matchAll(/function ([A-Za-z_$][\w$]*)\(/g)) decl = m;
  if (!decl) throw new Error('System-message builder declaration not found');
  const declStart = Math.max(0, anchor - 20000) + decl.index;
  const paramsOpen = declStart + decl[0].length;
  if (source[paramsOpen] !== '{') throw new Error('System-message builder no longer takes a destructured options object');
  const paramsEnd = findBlockEnd(source, paramsOpen) + 1;
  const paramsSrc = source.slice(paramsOpen, paramsEnd);
  const override = new RegExp(`systemPromptOverride:(${IDENT})`).exec(paramsSrc)?.[1];
  if (!override) throw new Error('System-message builder: systemPromptOverride parameter not found');
  if (source.slice(paramsEnd, paramsEnd + 2) !== '){') throw new Error('System-message builder: unexpected parameter list');
  const bodyStart = paramsEnd + 2;
  const bodyEnd = findBlockEnd(source, bodyStart - 1);
  return { declStart, paramsSrc, bodyStart, bodyEnd, body: source.slice(bodyStart, bodyEnd), override };
}

// Identifiers an expression reads from its surrounding scope (property names,
// keywords, and string contents excluded).
function freeIdentifiers(expr) {
  const code = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  const ids = new Set();
  for (const m of code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    if (!JS_WORDS.has(m[0])) ids.add(m[0]);
  }
  return ids;
}

// Work out where the router goes and prove the main prompt's template can be
// re-rendered by a copy placed next to the builder: the template function must
// be nothing but `return <literal>` with plain identifier params, and every
// free identifier in its expressions must not be shadowed inside the builder.
function analyzeRouterTargets(source, mainLiteral) {
  const builder = systemMessageBuilder(source);
  const ov = escapeRegex(builder.override);
  const mains = [...builder.body.matchAll(new RegExp(`(${IDENT})=${ov}\\?\\?(${IDENT})\\(\\)`, 'g'))];
  if (mains.length !== 1) throw new Error(`System-message builder: expected one "${builder.override}??main()" expression, found ${mains.length}`);
  const ids = [...builder.body.matchAll(new RegExp(`\\[\\{type:"text",text:(${IDENT})\\},\\{type:"text",text:${IDENT}\\}\\]`, 'g'))];
  if (ids.length !== 1) throw new Error(`System-message builder: expected one [identity, main] block list, found ${ids.length}`);
  const [mainExpr, mainLocal, mainFn] = mains[0];

  const wrapper = functionBody(source, mainFn);
  if (!wrapper) throw new Error(`Main prompt function ${mainFn} not found (or declared more than once)`);
  if (wrapper.params.trim() !== '') throw new Error(`Main prompt function ${mainFn} now takes parameters; the router cannot call it safely`);
  const call = new RegExp(`^\\s*return (${IDENT})\\(([\\s\\S]*)\\);?\\s*$`).exec(wrapper.body);
  if (!call) throw new Error(`Main prompt function ${mainFn} no longer just renders a template function`);
  const [, templateFn, templateArgs] = call;
  const template = functionBody(source, templateFn);
  if (!template) throw new Error(`Main prompt template ${templateFn} not found (or declared more than once)`);
  const params = template.params.split(',').map((p) => p.trim()).filter(Boolean);
  if (!params.every((p) => new RegExp(`^${IDENT}$`).test(p))) {
    throw new Error(`Main prompt template ${templateFn} has non-trivial parameters (${template.params})`);
  }
  const ret = /^\s*return\s*/.exec(template.body);
  const literalStart = template.start + (ret ? ret[0].length : 0);
  if (!ret || literalStart !== (mainLiteral.markerStart ?? mainLiteral.start)) throw new Error(`Main prompt template ${templateFn} is no longer \`return <prompt 02>\``);
  const rest = source.slice(mainLiteral.end, template.end);
  if (!/^\s*;?\s*$/.test(rest)) throw new Error(`Main prompt template ${templateFn} does more than return prompt 02`);

  const body = source.slice(builder.bodyStart, builder.bodyEnd);
  const free = new Set([...mainLiteral.exprs, templateArgs].flatMap((e) => [...freeIdentifiers(e)]));
  for (const p of params) free.delete(p);
  for (const name of free) {
    const n = escapeRegex(name);
    const declarations = [
      new RegExp(`[{,:]\\s*${n}\\s*[,}=]`).test(builder.paramsSrc), // destructured parameter
      new RegExp(`\\b(?:let|const|var)\\s+${n}(?![\\w$])`).test(body),
      new RegExp(`\\b(?:let|const|var)\\s[^;]*?,\\s*${n}\\s*=(?!=)`).test(body), // later name in a let chain
      new RegExp(`\\(\\s*(?:${IDENT}\\s*,\\s*)*${n}\\s*(?:,\\s*${IDENT}\\s*)*\\)\\s*=>`).test(body), // arrow param
      new RegExp(`(?<![\\w$])${n}\\s*=>`).test(body),
      new RegExp(`catch\\(\\s*${n}\\s*\\)`).test(body),
      new RegExp(`function\\s*(?:${IDENT})?\\s*\\([^)]*(?<![\\w$])${n}(?![\\w$])[^)]*\\)`).test(body),
    ];
    if (declarations.some(Boolean)) {
      throw new Error(`Prompt 02 reads "${name}", which the system-message builder shadows; the router cannot copy it`);
    }
  }
  return { builder, mainExpr, mainLocal, mainFn, identityVar: ids[0][1], identityExpr: ids[0][0], templateParams: params.join(','), templateArgs };
}

// Prompt files cannot reliably carry trailing newlines (editors add or strip
// them, and older tweakdroid versions dropped them), so an override that differs
// from its baseline only there counts as unchanged.
const sameText = (a, b) => a.replace(/\n+$/, '') === b.replace(/\n+$/, '');

function effectiveContent(dir, prompt, baseline) {
  const edited = readEditedPrompt(dir, prompt)?.content;
  return edited !== undefined && !sameText(edited, baseline) ? edited : baseline;
}

// Install the router into pristine-plus-literal-edits source when some
// provider's 01/02 differs from the all-providers text. Returns the new source
// and the providers that got their own text.
function applyProviderRouter(source, dir, factory) {
  const identityBase = factory.get('core_identity_base');
  const mainBase = factory.get('main_interactive_base');
  if (!identityBase || !mainBase) return { source, skipped: 'prompt 01 or 02 is missing from this build' };
  const byId = (id) => PROMPTS.find((p) => p.id === id);
  const baseIdentity = effectiveContent(dir, byId('core_identity_base'), identityBase.content);
  const baseMain = effectiveContent(dir, byId('main_interactive_base'), mainBase.content);
  const variants = {};
  const routed = [];
  for (const provider of PROVIDERS) {
    variants[provider] = {
      identity: effectiveContent(dir, byId(`core_identity_${provider}`), baseIdentity),
      main: effectiveContent(dir, byId(`main_interactive_${provider}`), baseMain),
    };
    if (variants[provider].identity !== baseIdentity || variants[provider].main !== baseMain) routed.push(provider);
  }
  if (routed.length === 0) return { source, routed };

  // mainBase was located in pristine source; find it again after literal edits.
  const mainNow = markedLiterals(source).find((m) => m.id === 'main_interactive_base') ?? locateLiteral(source, byId('main_interactive_base'));
  const t = analyzeRouterTargets(source, { ...mainNow, exprs: mainBase.exprs });
  const entries = PROVIDERS.map(
    (p) =>
      `${p}:{identity:${buildInterpolatedLiteral(variants[p].identity, identityBase.exprs)},` +
      `main:function(${t.templateParams}){return ${buildInterpolatedLiteral(variants[p].main, mainBase.exprs)}}}`
  ).join(',');
  const object =
    `${ROUTER_START}var twd_provider_prompts={pick(m){return this.v[m==="openai"?"openai":m==="google"?"google":"anthropic"]},` +
    `identity(m){return this.pick(m).identity},main(m){return this.pick(m).main(${t.templateArgs})},v:{${entries}}};${ROUTER_END}`;

  const routedMain = `${t.mainLocal}=${t.builder.override}??(twd_provider_prompts.main(${ROUTER_PROVIDER})??${t.mainFn}())`;
  const idNeedle = `text:${t.identityVar}}`;
  const idAt = t.identityExpr.indexOf(idNeedle);
  const routedIdentity =
    t.identityExpr.slice(0, idAt) +
    `text:(twd_provider_prompts.identity(${ROUTER_PROVIDER})??${t.identityVar})}` +
    t.identityExpr.slice(idAt + idNeedle.length);
  const mainAt = t.builder.body.indexOf(t.mainExpr);
  const identityAt = t.builder.body.indexOf(t.identityExpr);
  const body = spliceAll(t.builder.body, [
    { start: mainAt, end: mainAt + t.mainExpr.length, text: routedMain, label: 'main prompt expression' },
    { start: identityAt, end: identityAt + t.identityExpr.length, text: routedIdentity, label: 'identity block' },
  ]);
  return {
    source:
      source.slice(0, t.builder.declStart) +
      object +
      source.slice(t.builder.declStart, t.builder.bodyStart) +
      body +
      source.slice(t.builder.bodyEnd),
    routed,
  };
}

// ---------------------------------------------------------------------------
// no_comments for every model. Droid appends prompt 12 only for registry models
// whose systemPromptReminders include "no-comments" (Anthropic frontier models,
// and BYOK customs Droid maps onto them). --apply widens the gate to every
// model so GPT and unmapped custom models get it too; --restore narrows it back.
// The gate is searched for only inside the system-message builder.

const NO_COMMENTS_ORIG_RE = new RegExp(`if\\((${IDENT})\\.has\\("no-comments"\\)\\)`, 'g');
const NO_COMMENTS_PATCHED_RE = new RegExp(`if\\((${IDENT})\\.has\\("no-comments"\\)\\|\\|!0\\)`, 'g');

// The builder's body span, or null when this Droid build has no recognizable
// system-message builder (the gate patch is then skipped, not fatal).
function builderSpanOrNull(source) {
  try {
    return systemMessageBuilder(source);
  } catch {
    return null;
  }
}

function noCommentsWidened(source) {
  const builder = builderSpanOrNull(source);
  if (!builder) return false;
  return codeMatches(source, NO_COMMENTS_PATCHED_RE, builder.bodyStart, builder.bodyEnd).length > 0;
}

function applyNoCommentsForAll(source, enabled) {
  const builder = builderSpanOrNull(source);
  if (!builder) return { source, skipped: true };
  const patched = codeMatches(source, NO_COMMENTS_PATCHED_RE, builder.bodyStart, builder.bodyEnd);
  const orig = codeMatches(source, NO_COMMENTS_ORIG_RE, builder.bodyStart, builder.bodyEnd);
  const all = [...patched, ...orig];
  if (all.length === 0) return { source, skipped: true };
  if (all.length > 1) throw new Error(`no-comments gate is ambiguous (${all.length} matches in the system-message builder)`);
  const [m] = all;
  const target = enabled ? `if(${m[1]}.has("no-comments")||!0)` : `if(${m[1]}.has("no-comments"))`;
  if (m[0] === target) return { source, changed: false };
  return { source: source.slice(0, m.index) + target + source.slice(m.index + m[0].length), changed: true };
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
  // Grow only past the room the segment already has, so repeated restore/apply
  // cycles reuse earlier growth instead of extending the binary every time.
  const capacity = Number(segment.fileOffset + segment.fileSize - section.offset);
  const diff = newSection.length - capacity;
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
  let segEntry = -1;
  let segOffset = -1;
  let segFilesz = 0;
  let segMemsz = 0;
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
      break;
    }
  }
  if (segEntry === -1) {
    throw new Error('patchElfInPlace: LOAD segment for .bun not found');
  }

  // Reject only when another *loadable* segment shares the .bun LOAD segment's
  // file range. Non-LOAD headers (PT_TLS / PT_DYNAMIC / PT_GNU_RELRO) legitimately
  // alias into it (as of Droid 0.139.0 the Bun build places .bun in the shared RW
  // LOAD segment) and must not be treated as overlaps.
  for (let i = 0; i < ePhnum; i++) {
    const entry = ePhoff + i * ePhentsize;
    if (entry === segEntry) continue;
    if (orig.readUInt32LE(entry) !== PT_LOAD) continue;
    const offset = Number(orig.readBigUInt64LE(entry + P_OFFSET));
    const filesz = Number(orig.readBigUInt64LE(entry + P_FILESZ));
    if (offset >= segOffset + segFilesz || offset + filesz <= segOffset) continue;
    throw new Error('patchElfInPlace: another LOAD segment overlaps the .bun LOAD segment; not supported');
  }

  // The slot .bun may fill without moving anything: up to the end of its LOAD
  // segment's file range or the next section with file contents, whichever
  // comes first. Earlier growth (and room freed by a smaller patch) stays in the
  // slot, so repeated restore/apply cycles do not grow the file each time.
  const SH_TYPE = 0x04;
  const SHT_NOBITS = 8;
  const oldEnd = sectionFileOffset + oldSectionSize;
  let slotEnd = segOffset + segFilesz;
  for (let i = 0; i < eShnum; i++) {
    const entry = eShoff + i * eShentsize;
    if (i === sectionIdx || orig.readUInt32LE(entry + SH_TYPE) === SHT_NOBITS) continue;
    const off = Number(orig.readBigUInt64LE(entry + SH_OFFSET));
    if (off >= oldEnd && off < slotEnd && Number(orig.readBigUInt64LE(entry + SH_SIZE)) > 0) slotEnd = off;
  }
  slotEnd = Math.max(slotEnd, oldEnd);
  const newEnd = sectionFileOffset + newSection.length;
  const delta = newEnd - slotEnd;
  const tmp = `${outputPath}.tmp`;
  const finalize = (out) => {
    fs.writeFileSync(tmp, out);
    fs.chmodSync(tmp, fs.statSync(binaryPath).mode);
    fs.renameSync(tmp, outputPath);
  };

  // Fast path: the patched .bun fits in its slot. The rest of the file is
  // byte-for-byte identical; overwrite .bun, zero any freed tail, and update
  // the section size in the existing SHT.
  if (delta <= 0) {
    const out = Buffer.from(orig);
    newSection.copy(out, sectionFileOffset);
    if (newEnd < oldEnd) out.fill(0, newEnd, oldEnd);
    out.writeBigUInt64LE(BigInt(newSection.length), eShoff + sectionIdx * eShentsize + SH_SIZE);
    finalize(out);
    return;
  }

  // Grow path: .bun is the last section by file offset in its LOAD segment; only
  // the segment's alignment pad, non-allocated sections (.comment/.symtab/.strtab/
  // .shstrtab/...) and the section header table follow it in the file — none of
  // which are referenced by a program header or by dynamic linking. Insert `delta`
  // bytes at the end of the slot and slide that trailing region forward, fixing
  // up every file offset that moves: the SHT location, the moved sections'
  // sh_offset, and the containing segment's file/mem size. Refuse if any program
  // header begins after the slot (sliding it would break its mapped-address
  // congruence).
  for (let i = 0; i < ePhnum; i++) {
    const entry = ePhoff + i * ePhentsize;
    if (Number(orig.readBigUInt64LE(entry + P_OFFSET)) >= slotEnd) {
      throw new Error('patchElfInPlace: a program header starts after .bun; in-place growth unsupported for this layout');
    }
  }
  const out = Buffer.alloc(orig.length + delta);
  orig.copy(out, 0, 0, sectionFileOffset);
  newSection.copy(out, sectionFileOffset);
  orig.copy(out, newEnd, slotEnd);

  const newShoff = eShoff + delta;
  out.writeBigUInt64LE(BigInt(newShoff), E_SHOFF);
  for (let i = 0; i < eShnum; i++) {
    const entry = newShoff + i * eShentsize;
    if (i === sectionIdx) {
      out.writeBigUInt64LE(BigInt(newSection.length), entry + SH_SIZE);
      continue;
    }
    const off = Number(out.readBigUInt64LE(entry + SH_OFFSET));
    if (off >= slotEnd) out.writeBigUInt64LE(BigInt(off + delta), entry + SH_OFFSET);
  }
  out.writeBigUInt64LE(BigInt(segFilesz + delta), segEntry + P_FILESZ);
  out.writeBigUInt64LE(BigInt(segMemsz + delta), segEntry + P_MEMSZ);
  finalize(out);
}

// ---------------------------------------------------------------------------
// Factory Router (Auto Model) on BYOK custom models.

function readRouterByokMap(dir) {
  const file = path.join(dir, 'router-byok-map.json');
  if (!fs.existsSync(file)) return {};
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid router-byok-map.json: ${error.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(
      'router-byok-map.json must be a JSON object mapping a factory model id to a "custom:" id'
    );
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string' || !value.startsWith('custom:')) {
      throw new Error(`router-byok-map.json: "${key}" must map to a "custom:" model id, got ${JSON.stringify(value)}`);
    }
    // The patched resolver is recognized by a brace-free object literal.
    if (/[{}]/.test(key) || /[{}]/.test(value)) {
      throw new Error(`router-byok-map.json: model ids cannot contain "{" or "}" (${JSON.stringify(key)})`);
    }
  }
  return obj;
}

// Binary patch: route Factory Router ("auto") through the user's BYOK custom
// models. The router resolves "auto" to bare registry ids (its classifier model
// and the candidate it selects), which the custom-model resolver rejects
// (returns null), so the completion goes to Factory's billed endpoint. Prepending
// a remap to that resolver rewrites those ids to the user's "custom:" ids, so it
// returns the user's proxy config (baseUrl/apiKey) and every router call flows
// through their proxy. The router's selection logic is untouched. Mapping lives
// in router-byok-map.json (empty/absent => feature off).
function applyRouterByokRemap(source, mapObj, enabled) {
  const sig = `function (${IDENT})\\((${IDENT}),(${IDENT})\\)\\{`;
  // The resolver's head is the custom: guard followed by the Array.isArray(R)
  // guard. The id-slug parser shares the first guard, so anchoring on the second
  // one disambiguates.
  const tail =
    `if\\(!\\2\\.startsWith\\("custom:"\\)\\)return null;` +
    `if\\(!Array\\.isArray\\(\\3\\)\\|\\|\\3\\.length===0\\)return null;`;
  const patchedRe = new RegExp(`${sig}\\2=\\{[^{}]*\\}\\[\\2\\]\\|\\|\\2;${tail}`, 'g');
  const origRe = new RegExp(`${sig}${tail}`, 'g');
  const guards = (p1, p2) =>
    `if(!${p1}.startsWith("custom:"))return null;if(!Array.isArray(${p2})||${p2}.length===0)return null;`;
  const patchedForm = (name, p1, p2) =>
    `function ${name}(${p1},${p2}){${p1}=${JSON.stringify(mapObj)}[${p1}]||${p1};${guards(p1, p2)}`;
  const bareForm = (name, p1, p2) => `function ${name}(${p1},${p2}){${guards(p1, p2)}`;

  const patched = codeMatches(source, patchedRe);
  const orig = codeMatches(source, origRe);
  const all = [...patched, ...orig];
  if (all.length === 0) return { source, skipped: true, patched: false };
  if (all.length > 1) throw new Error(`Custom-model resolver is ambiguous (${all.length} matches)`);
  const [m] = all;
  const [whole, name, p1, p2] = m;
  const target = enabled ? patchedForm(name, p1, p2) : bareForm(name, p1, p2);
  return {
    source: whole === target ? source : source.slice(0, m.index) + target + source.slice(m.index + whole.length),
    changed: whole !== target,
    patched: patched.length > 0,
  };
}

function parseStringArray(source, name) {
  const m = new RegExp(`(?<![\\w$.])${escapeRegex(name)}=(\\[[^\\]]*\\])`).exec(source);
  if (!m) return null;
  try {
    const list = JSON.parse(m[1]);
    return Array.isArray(list) && list.every((x) => typeof x === 'string') ? list : null;
  } catch {
    return null;
  }
}

// The model ids Auto Model can emit, read from pristine source. `candidates` is
// the built-in candidate list (Factory can replace it at runtime through the
// factory_router_candidates dynamic config); `classifiers` is the ordered list
// Droid walks to pick the classifier model (the first one the account may use).
function routerLabels(source) {
  const result = { candidates: null, classifiers: null };
  const cardError = source.indexOf('Router candidate reasoningEffort is not in the registry supported set');
  if (cardError !== -1) {
    let decl = null;
    for (const m of source.slice(Math.max(0, cardError - 2000), cardError).matchAll(/function ([A-Za-z_$][\w$]*)\(/g)) decl = m;
    if (decl) {
      const list = new RegExp(
        `Object\\.freeze\\((${IDENT})\\.map\\(\\((${IDENT})\\)=>${escapeRegex(decl[1])}\\(\\2\\)\\)\\)`
      ).exec(source);
      if (list) result.candidates = parseStringArray(source, list[1]);
    }
  }
  const classifierLoop = new RegExp(
    `for\\(let (${IDENT}) of (${IDENT})\\)\\{let (${IDENT})=${IDENT}\\(\\1\\);if\\(\\3!==void 0\\)return\\{modelId:\\3,telemetrySource:`
  ).exec(source);
  if (classifierLoop) result.classifiers = parseStringArray(source, classifierLoop[2]);
  return result;
}

function warnUnmappedRouterLabels(source, routerMap) {
  if (Object.keys(routerMap).length === 0) return;
  const { candidates, classifiers } = routerLabels(source);
  if (!candidates || !classifiers) {
    console.warn('Warning: could not read Auto Model candidate labels from this binary; check router-byok-map.json keys by hand.');
    return;
  }
  // Droid uses the first classifier id the account may use, so every fallback
  // ahead of the first candidate can end up as the classifier.
  const firstCandidate = classifiers.findIndex((id) => candidates.includes(id));
  const classifierOnly = classifiers.slice(0, firstCandidate === -1 ? undefined : firstCandidate);
  const unmapped = [
    ...classifierOnly.filter((id) => !routerMap[id]).map((id) => `${id} (classifier)`),
    ...candidates.filter((id) => !routerMap[id]),
  ];
  if (unmapped.length > 0) {
    console.warn(
      `Warning: router-byok-map.json has no entry for these Auto Model labels; if the router picks one it goes to Factory's billed endpoint:\n` +
        unmapped.map((id) => `  - ${id}`).join('\n')
    );
  }
}

// ---------------------------------------------------------------------------
// Feature flags

const FEATURE_FLAG_RE_SRC =
  '([A-Za-z][A-Za-z0-9_$]*):\\{displayName:"([^"]*)",statsigName:"([^"]*)",defaultValue:(![01])\\}';

function parseFeatureFlags(source) {
  const re = new RegExp(FEATURE_FLAG_RE_SRC, 'g');
  const flags = [];
  for (const m of source.matchAll(re)) {
    flags.push({
      name: m[1],
      displayName: m[2],
      statsigName: m[3],
      enabled: m[4] === '!0',
    });
  }
  return flags;
}

function readFeatureFlags(dir) {
  const file = path.join(dir, 'feature-flags.json');
  if (!fs.existsSync(file)) return {};
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid feature-flags.json: ${error.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('feature-flags.json must be a JSON object of { "statsigName": true|false }');
  }
  return obj;
}

// Binary patch: force Statsig feature flags on/off. Flipping a flag's
// defaultValue is not enough: the resolver consults
// FACTORY_FEATURE_FLAGS_OVERRIDES, the server store, and the disk cache before
// the default, so a server value (e.g. alloy=false for a non-entitled org) wins.
// Instead an override lookup goes at the very top of the resolver (the function
// that destructures {statsigName, defaultValue} from its first parameter), so
// tweakdroid's choices win for every check that goes through it. flagsMap is
// { statsigName: bool }; absent flags fall through to normal resolution.
function applyFeatureFlagsPatch(source, flagsMap, restore) {
  const map = {};
  for (const [k, v] of Object.entries(flagsMap)) {
    if (typeof v === 'boolean') map[k] = v;
  }
  const enabled = !restore && Object.keys(map).length > 0;
  const head = `function (${IDENT})\\((${IDENT})((?:,${IDENT})*)\\)\\{`;
  const resolverBody = `(?=let\\{statsigName:${IDENT},defaultValue:${IDENT}\\}=\\2[,;])`;
  const patchedRe = new RegExp(
    `${head}let twdFF=\\{[^{}]*\\}\\[\\2\\.statsigName\\];if\\(twdFF!==void 0\\)return twdFF;${resolverBody}`,
    'g'
  );
  const origRe = new RegExp(`${head}${resolverBody}`, 'g');
  const literal =
    '{' +
    Object.entries(map)
      .map(([k, v]) => `${JSON.stringify(k)}:${v ? '!0' : '!1'}`)
      .join(',') +
    '}';
  const build = (n, p, rest) =>
    `function ${n}(${p}${rest}){let twdFF=${literal}[${p}.statsigName];if(twdFF!==void 0)return twdFF;`;
  const bare = (n, p, rest) => `function ${n}(${p}${rest}){`;

  const all = [...codeMatches(source, patchedRe), ...codeMatches(source, origRe)];
  if (all.length === 0) return { source, skipped: true };
  if (all.length > 1) throw new Error(`Feature-flag resolver is ambiguous (${all.length} matches)`);
  const [m] = all;
  const [whole, n, p, rest] = m;
  const target = enabled ? build(n, p, rest) : bare(n, p, rest);
  return {
    source: whole === target ? source : source.slice(0, m.index) + target + source.slice(m.index + whole.length),
    changed: whole !== target,
  };
}

function listFlags(binaryPath) {
  const source = restoreSource(getSource(binaryPath).source);
  console.log(JSON.stringify(parseFeatureFlags(source), null, 2));
}

function listRouterLabels(binaryPath) {
  const source = restoreSource(getSource(binaryPath).source);
  console.log(JSON.stringify(routerLabels(source), null, 2));
}

// ---------------------------------------------------------------------------
// Apply / restore
//
// Both start from the pristine bundle (the binary restored in memory), so the
// result depends only on Droid and your config: applying twice changes nothing,
// and restore needs nothing but the binary.

// The span tweakdroid owns for a prompt in `source`: its marker plus literal
// when patched, else the factory literal found by fingerprint.
function currentSpan(source, prompt, marked) {
  const m = marked.find((x) => x.id === prompt.id);
  if (m) return source.slice(m.markerStart, m.end);
  const literal = locateLiteral(source, prompt);
  return literal ? literal.literal : null;
}

function buildPatchedSource(base, dir) {
  const factory = locateFactoryPrompts(base);
  const edits = [];
  for (const prompt of PROMPTS) {
    if (prompt.router) continue;
    const literal = factory.get(prompt.id);
    if (!literal) continue;
    const target = effectiveContent(dir, prompt, literal.content);
    if (target === literal.content) continue;
    edits.push({
      start: literal.start,
      end: literal.end,
      text: markerFor(prompt.id, literal.literal) + buildInterpolatedLiteral(target, literal.exprs),
      label: prompt.id,
      prompt,
    });
  }
  let next = spliceAll(base, edits);

  const router = applyProviderRouter(next, dir, factory);
  next = router.source;
  const noComments = applyNoCommentsForAll(next, true);
  next = noComments.source;
  const routerMap = readRouterByokMap(dir);
  const remap = applyRouterByokRemap(next, routerMap, Object.keys(routerMap).length > 0);
  next = remap.source;
  const flagsMap = readFeatureFlags(dir);
  const flags = applyFeatureFlagsPatch(next, flagsMap, false);
  next = flags.source;
  return { next, factory, edits, router, noComments, remap, routerMap, flagsMap, flags };
}

function apply(binaryPath, dir, outputPath, dryRun, restore) {
  const { source } = getSource(binaryPath);
  const base = restoreSource(source);
  const notes = [];
  let next = base;
  let routed = [];
  if (!restore) {
    const manifest = readManifest(dir);
    const version = droidVersion(base);
    if (manifest && manifest.droidVersion !== version) {
      console.warn(
        `Warning: system-prompts were extracted from Droid ${manifest.droidVersion ?? '(unknown)'}, but the binary is Droid ${version ?? '(unknown)'}; run tweakdroid --extract to refresh them.`
      );
    }
    const built = buildPatchedSource(base, dir);
    next = built.next;
    routed = built.router.routed ?? [];
    if (built.router.skipped) notes.push(`(provider router skipped: ${built.router.skipped})`);
    if (built.noComments.skipped) notes.push('(no-comments gate not found in this droid version; skipped)');
    if (built.remap.skipped) notes.push('(custom-model resolver not found in this droid version; Auto Model remap skipped)');
    if (built.flags.skipped) notes.push('(feature-flag resolver not found in this droid version; skipped)');
    warnUnmappedRouterLabels(base, built.routerMap);
    const known = new Set(parseFeatureFlags(base).map((f) => f.statsigName));
    const unknown = Object.keys(built.flagsMap).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      console.warn(`Warning: feature-flags.json names flags this Droid build does not have: ${unknown.join(', ')}`);
    }
    reportOverrideHealth(dir, built.factory);
  }

  // Report only what differs between the binary and the result.
  const rows = [];
  const markedBefore = markedLiterals(source);
  const markedAfter = markedLiterals(next);
  for (const prompt of PROMPTS) {
    if (prompt.router || !prompt.fingerprint) continue;
    const before = currentSpan(source, prompt, markedBefore);
    const after = currentSpan(next, prompt, markedAfter);
    if (before !== after) rows.push(`${prompt.file}: ${before?.length ?? 0} -> ${after?.length ?? 0} bytes`);
  }
  const span = (s, r) => (r ? s.slice(r[0], r[1]) : '');
  const routerBefore = span(source, routerRegion(source));
  const routerAfter = span(next, routerRegion(next));
  if (routerBefore !== routerAfter) {
    rows.push(
      `(provider router for 01/02${routerAfter ? `: own text for ${routed.join(', ')}` : ' removed'}): ${routerBefore.length} -> ${routerAfter.length} bytes`
    );
  }
  const gateRows = [
    [noCommentsWidened(source), noCommentsWidened(next), 'no-comments block for every model'],
    [applyRouterByokRemap(source, {}, false).patched, applyRouterByokRemap(next, {}, false).patched, 'Auto Model remap to BYOK custom models'],
  ];
  for (const [was, now, label] of gateRows) {
    if (was !== now) rows.push(`(${label}: ${now ? 'added' : 'removed'})`);
  }
  const remapText = (s) => /function [\w$]+\(([\w$]+),[\w$]+\)\{\1=(\{[^{}]*\})\[\1\]\|\|\1;/.exec(s)?.[2] ?? '';
  if (remapText(source) && remapText(next) && remapText(source) !== remapText(next)) rows.push('(Auto Model remap: mapping updated)');
  const flagsText = (s) => /let twdFF=(\{[^{}]*\})/.exec(s)?.[1] ?? '';
  if (flagsText(source) !== flagsText(next)) {
    const forced = flagsText(next);
    rows.push(forced ? `(feature flags forced: ${forced})` : '(feature-flag overrides removed)');
  }

  const changed = next !== source;
  if (changed) assertParses(next);
  if (dryRun) {
    console.log(changed ? 'Dry run: source would change.' : 'Dry run: no changes.');
    for (const line of [...rows, ...notes]) console.log(line);
    return;
  }
  for (const line of notes) console.log(line);
  if (!changed) {
    console.log(
      restore
        ? 'No restore needed; the binary carries no tweakdroid patches.'
        : 'No changes to apply; the binary already matches your configuration.'
    );
    return;
  }
  repack(binaryPath, next, outputPath || binaryPath);
  for (const line of rows) console.log(line);
  console.log(
    restore
      ? `Restored factory Droid to ${outputPath || binaryPath}`
      : `Applied prompt changes to ${outputPath || binaryPath}`
  );
}

// Refuse to write a binary whose patched bundle would not even parse.
function assertParses(js) {
  const file = path.join(os.tmpdir(), `tweakdroid-check-${process.pid}.mjs`);
  fs.writeFileSync(file, js);
  try {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`Patched Droid bundle does not parse; binary left untouched.\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function launchTui(argv) {
  const entry = fileURLToPath(new URL('./tui/index.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [entry, ...argv], { stdio: 'inherit' });
  process.exit(child.status ?? 0);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  const actions = [args.extract, args.apply, args.restore, args.listFlags, args.listRouterLabels].filter(
    Boolean
  ).length;
  if (actions === 0) {
    // No action flags: launch the interactive TUI.
    launchTui(process.argv.slice(2));
    return;
  }
  const binary = path.resolve(args.binary || defaultDroidPath());
  if (args.listFlags) {
    listFlags(binary);
    return;
  }
  if (args.listRouterLabels) {
    listRouterLabels(binary);
    return;
  }
  if ([args.extract, args.apply, args.restore].filter(Boolean).length !== 1) {
    usage();
    process.exit(1);
  }
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
