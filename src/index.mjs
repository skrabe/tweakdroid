#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import LIEF from 'node-lief';
import { HIDDEN_COMMANDS, FLAG_NOTES, SETTINGS } from './catalog.mjs';
import { readFactorySettings, updateFactorySettings, factorySettingsPath, getPath } from './factory-settings.mjs';
import { nativeByokStatus, assignNativeByok, unassignNativeByok } from './native-byok.mjs';

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
    fingerprint: 'CRITICAL: You have dedicated tools for file I/O.',
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
    '<system-reminder>\nYou are a worker assigned to execute feature',
    'system-reminder assigning a feature to a mission worker.'),
  injected('16', 'startup-env', 'startup_env',
    '# The commands below ran once at session start to gather environment context.',
    'Startup environment block injected on the first turn (OS, date, model, language, directory/git info, project and personal instructions).'),
  injected('18', 'reminder-deferred-tools', 'reminder_deferred_tools',
    'The tools listed below are available in this environment, but their schemas may be omitted',
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
  injected('29', 'notification-ls-cwd-warning', 'notification_ls_cwd_warning',
    "WARNING: '.' was replaced with ",
    'LS-tool warning that "." was replaced with an absolute path.'),
  injected('30', 'notification-tagged-dir', 'notification_tagged_dir',
    'User tagged directory: ',
    'Reminder noting a directory the user @-tagged.'),
  injected('31', 'notification-dir-contents', 'notification_dir_contents',
    'Contents of directory ',
    'Reminder labelling injected directory-listing output.'),
  injected('32', 'notification-tagged-file', 'notification_tagged_file',
    'User tagged file: ',
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
    flag: [],
    setting: [],
    unhide: [],
    nativeAssign: [],
    nativeUnassign: [],
  };
  const value = (i, arg) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${arg} needs a value`);
    return argv[i];
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--extract') args.extract = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--restore') args.restore = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--binary') args.binary = value(++i, arg);
    else if (arg === '--dir') args.dir = value(++i, arg);
    else if (arg === '--output') args.output = value(++i, arg);
    else if (arg === '--list-flags') args.listFlags = true;
    else if (arg === '--list-router-labels') args.listRouterLabels = true;
    else if (arg === '--list-hidden') args.listHidden = true;
    else if (arg === '--list-settings') args.listSettings = true;
    else if (arg === '--native-byok') args.nativeStatus = true;
    else if (arg === '--flag') args.flag.push(value(++i, arg));
    else if (arg === '--setting') args.setting.push(value(++i, arg));
    else if (arg === '--unhide') args.unhide.push(value(++i, arg));
    else if (arg === '--native-byok-assign') args.nativeAssign.push(value(++i, arg));
    else if (arg === '--native-byok-unassign') args.nativeUnassign.push(value(++i, arg));
    else if (arg === '--dump-source') args.dumpSource = value(++i, arg);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(`Usage:
  tweakdroid                     launch the interactive TUI (no args)

Patch the binary (always rebuilt from the factory bundle):
  tweakdroid --extract [--binary /path/to/droid] [--dir folder]
  tweakdroid --apply [--dry-run] [--binary /path/to/droid] [--dir folder] [--output /path/to/droid]
  tweakdroid --restore [--dry-run] [--binary /path/to/droid] [--dir folder] [--output /path/to/droid]

Toggles patched into the binary on the next --apply:
  tweakdroid --list-flags                 feature flags: default, cached server value, forced value
  tweakdroid --flag NAME=on|off|default   force a feature flag (repeatable)
  tweakdroid --list-hidden                hidden subcommands/options tweakdroid can show
  tweakdroid --unhide NAME=on|off         show a hidden subcommand in droid --help (repeatable)

Droid settings (written to ~/.factory/settings.json right away; no --apply needed):
  tweakdroid --list-settings              settings toggles with their current values
  tweakdroid --setting KEY=VALUE|unset    set or remove one (repeatable)

Native Auto Model BYOK:
  tweakdroid --native-byok                status: flag, policy, label -> custom model
  tweakdroid --native-byok-assign LABEL=custom:ID   route an Auto Model label to a custom model
  tweakdroid --native-byok-unassign LABEL

Inspect:
  tweakdroid --list-router-labels         Auto Model labels as JSON
  tweakdroid --dump-source FILE           write the factory JS bundle (for finding fingerprints)

Default folder: ~/.tweakdroid
Default binary: first droid found on PATH`);
}

// The binary when one is given or on PATH, else null (for actions that only
// use it for extra information).
function optionalBinary(explicit) {
  if (explicit) return path.resolve(explicit);
  try {
    return path.resolve(defaultDroidPath());
  } catch {
    return null;
  }
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

// Droid ships as many code-split ES modules. tweakdroid works on one text, the
// bundle: every JavaScript module in table order, each introduced by a
// separator comment naming it. Patches and fingerprints see that text; repack
// splits it again and writes back only the modules whose text changed.
const LOADER_JS = 1;
const ENCODING_LATIN1 = 1;
const ENCODING_UTF16 = 2;
const CHUNK_SEPARATOR = /\n\/\*twd-chunk ([^*\n]+)\*\/\n/;
const chunkHeader = (name) => `\n/*twd-chunk ${name}*/\n`;

function isJsModule(mod) {
  return mod.loader === LOADER_JS && mod.contentsBytes.length > 0;
}

function moduleText(mod) {
  return mod.encoding === ENCODING_UTF16
    ? mod.contentsBytes.toString('utf16le')
    : mod.contentsBytes.toString(mod.encoding === ENCODING_LATIN1 ? 'latin1' : 'utf8');
}

function bundleSource(modules) {
  let source = '';
  for (const mod of modules.filter(isJsModule)) {
    const text = moduleText(mod);
    if (CHUNK_SEPARATOR.test(text)) throw new Error(`${mod.nameBytes} already contains a tweakdroid chunk separator`);
    source += chunkHeader(mod.nameBytes.toString('utf8')) + text;
  }
  if (!source.includes('buildSystemMessageBlocks:') || !source.includes('name:"@factory/cli"')) {
    throw new Error('This binary does not look like Factory Droid (no Droid application code found)');
  }
  return source;
}

// The bundle split back into [name, text] pairs.
function splitBundle(source) {
  const parts = source.split(CHUNK_SEPARATOR);
  if (parts[0] !== '') throw new Error('The bundle does not start with a chunk separator');
  const chunks = [];
  for (let i = 1; i < parts.length; i += 2) chunks.push([parts[i], parts[i + 1]]);
  return chunks;
}

function getSource(binaryPath) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binaryPath);
  const { bunData, bunOffsets, moduleStructSize } = getBunData(binary);
  return { source: bundleSource(readModules(bunData, bunOffsets, moduleStructSize)) };
}

// How a patched module graph is laid out. Bun keeps tables after the module
// table (source hashes, shared bytecode, a prelinked module graph) that point
// into the blob by absolute offset, so tweakdroid never moves factory bytes.
// Patched module texts are appended after the factory graph, followed by a
// record of the factory values tweakdroid overwrote and a magic tag, then new
// Offsets and the trailer. A patched module's table entry points at its new
// text and loses its bytecode (Bun would otherwise run the precompiled factory
// code), its source hash is zeroed, and the "source text is one contiguous run"
// flag is cleared. Restore truncates to the factory graph and puts the
// recorded values back, which reproduces the factory blob byte for byte.
const TWD_MAGIC = Buffer.from('TWDBUN01');
const FLAG_SOURCE_TEXT_CONTIGUOUS = 1 << 4;
const FLAG_HAS_SOURCE_HASHES = 1 << 5;

function moduleTableEntry(bunOffsets, moduleStructSize, index) {
  return bunOffsets.modulesPtr.offset + index * moduleStructSize;
}

function sourceHashAt(bunOffsets, index) {
  if (!(bunOffsets.flags & FLAG_HAS_SOURCE_HASHES)) return null;
  return bunOffsets.modulesPtr.offset + bunOffsets.modulesPtr.length + index * 4;
}

function factoryBunData(bunData) {
  const { bunOffsets } = parseBunDataBlob(bunData);
  const end = Number(bunOffsets.byteCount);
  if (end < 12 || !bunData.subarray(end - TWD_MAGIC.length, end).equals(TWD_MAGIC)) return bunData;
  const recordLength = bunData.readUInt32LE(end - TWD_MAGIC.length - 4);
  const recordEnd = end - TWD_MAGIC.length - 4;
  const record = JSON.parse(bunData.toString('utf8', recordEnd - recordLength, recordEnd));
  const out = Buffer.concat([
    bunData.subarray(0, record.byteCount),
    Buffer.from(record.offsets, 'hex'),
    BUN_TRAILER,
  ]);
  for (const patch of record.patches) {
    Buffer.from(patch.entry, 'hex').copy(out, patch.entryAt);
    if (patch.hashAt !== null) out.writeUInt32LE(patch.hash, patch.hashAt);
  }
  return out;
}

function encodeModuleText(text) {
  return /^[\x00-\x7f]*$/.test(text)
    ? { bytes: Buffer.from(text, 'latin1'), encoding: ENCODING_LATIN1 }
    : { bytes: Buffer.from(text, 'utf16le'), encoding: ENCODING_UTF16 };
}

// The factory blob with every module whose bundle text differs replaced.
function patchedBunData(factory, source) {
  const { bunOffsets, moduleStructSize } = parseBunDataBlob(factory);
  const modules = readModules(factory, bunOffsets, moduleStructSize).filter(isJsModule);
  const chunks = splitBundle(source);
  if (chunks.length !== modules.length || chunks.some(([name], i) => name !== modules[i].nameBytes.toString('utf8'))) {
    throw new Error('The patched bundle does not match the modules of this Droid binary');
  }
  const byteCount = Number(bunOffsets.byteCount);
  const parts = [Buffer.from(factory.subarray(0, byteCount))];
  const head = parts[0];
  let pos = byteCount;
  const pad = (align) => {
    const n = (align - (pos % align)) % align;
    if (n) parts.push(Buffer.alloc(n));
    pos += n;
  };
  const record = {
    byteCount,
    offsets: factory.subarray(byteCount, byteCount + SIZEOF_OFFSETS).toString('hex'),
    patches: [],
  };
  chunks.forEach(([, text], i) => {
    const mod = modules[i];
    if (text === moduleText(mod)) return;
    const { bytes, encoding } = encodeModuleText(text);
    pad(8);
    const entryAt = moduleTableEntry(bunOffsets, moduleStructSize, mod.index);
    const hashAt = sourceHashAt(bunOffsets, mod.index);
    record.patches.push({
      index: mod.index,
      entryAt,
      entry: head.subarray(entryAt, entryAt + moduleStructSize).toString('hex'),
      hashAt,
      hash: hashAt === null ? 0 : head.readUInt32LE(hashAt),
    });
    head.writeUInt32LE(pos, entryAt + 8);
    head.writeUInt32LE(bytes.length, entryAt + 12);
    head.writeUInt32LE(0, entryAt + 24);
    head.writeUInt32LE(0, entryAt + 28);
    head.writeUInt8(encoding, entryAt + moduleStructSize - 4);
    if (hashAt !== null) head.writeUInt32LE(0, hashAt);
    parts.push(bytes, Buffer.alloc(2));
    pos += bytes.length + 2;
  });
  if (record.patches.length === 0) return factory;
  const json = Buffer.from(JSON.stringify(record), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  parts.push(json, length, TWD_MAGIC);
  pos += json.length + 4 + TWD_MAGIC.length;
  const offsets = Buffer.from(factory.subarray(byteCount, byteCount + SIZEOF_OFFSETS));
  offsets.writeBigUInt64LE(BigInt(pos), 0);
  offsets.writeUInt32LE(bunOffsets.flags & ~FLAG_SOURCE_TEXT_CONTIGUOUS, 28);
  parts.push(offsets, BUN_TRAILER);
  return Buffer.concat(parts);
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

// Non-ASCII text is written as \u escapes, as Bun's bundler does, so a patched
// module stays plain ASCII (Bun stores it as Latin-1, like the factory module).
function buildInterpolatedLiteral(content, exprs) {
  const body = content
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
    .replaceAll('\r', '\\r')
    .replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
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
  next = stripUnhide(next);
  if (isPatched(next)) throw new Error('Could not remove every tweakdroid patch from this binary');
  return next;
}

function isPatched(source) {
  return (
    source.includes(MARKER_PREFIX) ||
    source.includes(ROUTER_START) ||
    source.includes('twd_provider_prompts') ||
    source.includes('let twdFF=') ||
    source.includes('let twdFS=') ||
    source.includes(UNHIDE_MARK) ||
    source.includes(EXEC_HELP_MARK) ||
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
// Droid builds the standard system message in one function (the one its
// platform object exports as buildSystemMessageBlocks):
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

// The [start, end) span of the bundle module that contains position `at`.
// Minified names are only unique within one module, so look them up there.
function moduleSpan(source, at) {
  const start = source.lastIndexOf('\n/*twd-chunk ', at);
  const next = source.indexOf('\n/*twd-chunk ', at);
  return [Math.max(0, start), next === -1 ? source.length : next];
}

// A function declared in the module that contains position `at`.
function functionBody(source, name, at) {
  const [from, to] = moduleSpan(source, at);
  const decls = [...source.slice(from, to).matchAll(new RegExp(`function ${escapeRegex(name)}\\(([^)]*)\\)\\{`, 'g'))];
  if (decls.length !== 1) return null;
  const start = from + decls[0].index + decls[0][0].length;
  const end = findBlockEnd(source, start - 1);
  return { params: decls[0][1], start, end, body: source.slice(start, end) };
}

// The function that assembles the standard system message, found through the
// platform object that exports it as buildSystemMessageBlocks. Returns its
// declaration, body span, and prompt-override param.
function systemMessageBuilder(source) {
  const exports = [...source.matchAll(new RegExp(`buildSystemMessageBlocks:(${IDENT})[,}]`, 'g'))];
  if (exports.length !== 1) throw new Error(`System-message builder: expected one buildSystemMessageBlocks export, found ${exports.length}`);
  const [from, to] = moduleSpan(source, exports[0].index);
  const decls = [...source.slice(from, to).matchAll(new RegExp(`function ${escapeRegex(exports[0][1])}\\(`, 'g'))];
  if (decls.length !== 1) throw new Error('System-message builder declaration not found');
  const decl = decls[0];
  const declStart = from + decl.index;
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
  // The identity block opens the block list; the main block after it may wrap
  // the main prompt (Droid appends extra sections for some models).
  const ids = [...builder.body.matchAll(new RegExp(`\\[\\{type:"text",text:(${IDENT})\\},\\{type:"text",text:`, 'g'))];
  if (ids.length !== 1) throw new Error(`System-message builder: expected one [identity, main] block list, found ${ids.length}`);
  const [mainExpr, mainLocal, mainFn] = mains[0];

  const wrapper = functionBody(source, mainFn, builder.bodyStart);
  if (!wrapper) throw new Error(`Main prompt function ${mainFn} not found (or declared more than once)`);
  if (wrapper.params.trim() !== '') throw new Error(`Main prompt function ${mainFn} now takes parameters; the router cannot call it safely`);
  const call = new RegExp(`^\\s*return (${IDENT})\\(([\\s\\S]*)\\);?\\s*$`).exec(wrapper.body);
  if (!call) throw new Error(`Main prompt function ${mainFn} no longer just renders a template function`);
  const [, templateFn, templateArgs] = call;
  const template = functionBody(source, templateFn, builder.bodyStart);
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

function repack(binaryPath, js, outputPath) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binaryPath);
  const { bunData, sectionHeaderSize, segment, section } = getBunData(binary);
  const newBun = patchedBunData(factoryBunData(bunData), js);
  const newSection = buildSectionData(newBun, sectionHeaderSize);
  if (binary.format === 'ELF') {
    patchElfInPlace(binaryPath, outputPath, Number(section.offset), newSection);
    return;
  }
  // Grow only past the room the segment already has, so repeated restore/apply
  // cycles reuse earlier growth instead of extending the binary every time.
  const capacity = Number(segment.fileOffset + segment.fileSize - section.offset);
  const diff = newSection.length - capacity;
  // When the bundle fits, write it in place: every byte outside the __bun slot,
  // its size field, and the signature stays as Droid shipped it.
  if (diff <= 0) {
    patchMachOInPlace(binaryPath, outputPath, newSection);
    codesign(outputPath);
    return;
  }
  if (binary.hasCodeSignature) binary.removeSignature();
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
  zeroBunSlack(tmp);
  fs.chmodSync(tmp, fs.statSync(binaryPath).mode);
  fs.renameSync(tmp, outputPath);
  codesign(outputPath);
}

function codesign(file) {
  try {
    execFileSync('codesign', ['-s', '-', '-f', file], { stdio: 'ignore' });
  } catch {
    console.warn('Warning: codesign failed; the patched binary may not run.');
  }
}

// Mach-O fast path: overwrite the __bun section inside its existing __BUN slot,
// zero the rest of the slot, and update the section's size in its load
// command. Load commands are read directly (mach_header_64, LC_SEGMENT_64).
function patchMachOInPlace(binaryPath, outputPath, newSection) {
  const LC_SEGMENT_64 = 0x19;
  const buf = fs.readFileSync(binaryPath);
  if (buf.readUInt32LE(0) !== 0xfeedfacf) throw new Error('patchMachOInPlace: not a 64-bit little-endian Mach-O');
  const ncmds = buf.readUInt32LE(16);
  let pos = 32;
  let found = null;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(pos);
    const cmdsize = buf.readUInt32LE(pos + 4);
    if (cmd === LC_SEGMENT_64 && buf.toString('latin1', pos + 8, pos + 24).replace(/\0+$/, '') === '__BUN') {
      const segFileOff = Number(buf.readBigUInt64LE(pos + 40));
      const segFileSize = Number(buf.readBigUInt64LE(pos + 48));
      const nsects = buf.readUInt32LE(pos + 64);
      for (let j = 0; j < nsects; j++) {
        const sect = pos + 72 + j * 80;
        if (buf.toString('latin1', sect, sect + 16).replace(/\0+$/, '') === '__bun') {
          found = { sizeField: sect + 40, offset: buf.readUInt32LE(sect + 48), segEnd: segFileOff + segFileSize };
        }
      }
    }
    pos += cmdsize;
  }
  if (!found) throw new Error('patchMachOInPlace: __BUN/__bun not found in the load commands');
  if (found.offset + newSection.length > found.segEnd) throw new Error('patchMachOInPlace: the bundle does not fit its slot');
  newSection.copy(buf, found.offset);
  buf.fill(0, found.offset + newSection.length, found.segEnd);
  buf.writeBigUInt64LE(BigInt(newSection.length), found.sizeField);
  const tmp = `${outputPath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.chmodSync(tmp, fs.statSync(binaryPath).mode);
  fs.renameSync(tmp, outputPath);
}

// The __BUN segment usually has room past the __bun section. Writing a smaller
// section leaves the previous, longer bundle's tail in that room; zero it, so
// the bytes of a written binary depend only on the bundle it carries (a
// restored binary then matches the factory one outside the signature, as long
// as the segment never had to grow).
function zeroBunSlack(file) {
  LIEF.logging.disable();
  const written = LIEF.parse(file);
  const segment = written.getSegment('__BUN');
  const section = segment?.getSection('__bun');
  if (!section) throw new Error('__bun section missing from the written binary');
  const start = Number(section.offset) + Number(section.size);
  const end = Number(segment.fileOffset + segment.fileSize);
  if (end <= start) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const chunk = Buffer.alloc(Math.min(end - start, 1 << 20));
    for (let pos = start; pos < end; pos += chunk.length) {
      fs.writeSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
    }
  } finally {
    fs.closeSync(fd);
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
  // The resolver's head is the custom: guard (inline, or a helper call in newer
  // builds) followed by the Array.isArray(R) guard. The id-slug parser shares
  // the first guard, so anchoring on the second one disambiguates.
  const tail =
    `(if\\(!(?:\\2\\.startsWith\\("custom:"\\)|${IDENT}\\(\\2\\))\\)return null;` +
    `if\\(!Array\\.isArray\\(\\3\\)\\|\\|\\3\\.length===0\\)return null;)`;
  const patchedRe = new RegExp(`${sig}\\2=\\{[^{}]*\\}\\[\\2\\]\\|\\|\\2;${tail}`, 'g');
  const origRe = new RegExp(`${sig}${tail}`, 'g');
  const patchedForm = (name, p1, p2, guards) =>
    `function ${name}(${p1},${p2}){${p1}=${JSON.stringify(mapObj)}[${p1}]||${p1};${guards}`;
  const bareForm = (name, p1, p2, guards) => `function ${name}(${p1},${p2}){${guards}`;

  const patched = codeMatches(source, patchedRe);
  const orig = codeMatches(source, origRe);
  const all = [...patched, ...orig];
  if (all.length === 0) return { source, skipped: true, patched: false };
  if (all.length > 1) throw new Error(`Custom-model resolver is ambiguous (${all.length} matches)`);
  const [m] = all;
  const [whole, name, p1, p2, guards] = m;
  const target = enabled ? patchedForm(name, p1, p2, guards) : bareForm(name, p1, p2, guards);
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
  const result = { candidates: null, classifiers: null, fastCandidates: null };
  const unique = (re) => {
    const all = [...source.matchAll(new RegExp(re.source, 'g'))];
    return all.length === 1 ? all[0] : null;
  };
  const cardError = source.indexOf('Router candidate reasoningEffort is not in the registry supported set');
  if (cardError !== -1 && source.indexOf('Router candidate reasoningEffort is not in the registry supported set', cardError + 1) === -1) {
    let decl = null;
    for (const m of source.slice(Math.max(0, cardError - 2000), cardError).matchAll(/function ([A-Za-z_$][\w$]*)\(/g)) decl = m;
    if (decl) {
      const list = unique(
        new RegExp(`Object\\.freeze\\((${IDENT})\\.map\\(\\((${IDENT})\\)=>${escapeRegex(decl[1])}\\(\\2\\)\\)\\)`)
      );
      if (list) result.candidates = parseStringArray(source, list[1]);
    }
  }
  const classifierLoop = unique(
    new RegExp(
      `for\\(let (${IDENT}) of (${IDENT})\\)\\{let (${IDENT})=${IDENT}\\(\\1\\);if\\(\\3!==void 0\\)return\\{modelId:\\3,telemetrySource:`
    )
  );
  if (classifierLoop) result.classifiers = parseStringArray(source, classifierLoop[2]);
  // Auto Model Fast swaps each candidate for its registry fast variant (the
  // registry entry whose baseVariant is the candidate).
  if (result.candidates) {
    const fast = new Map();
    for (const m of source.matchAll(/baseVariant:"([^"]+)"/g)) {
      const id = [...source.slice(Math.max(0, m.index - 600), m.index).matchAll(/\{id:"([^"]+)"/g)].at(-1)?.[1];
      if (id && !fast.has(m[1])) fast.set(m[1], id);
    }
    result.fastCandidates = result.candidates.map((id) => fast.get(id)).filter(Boolean);
  }
  return result;
}

// A flag's value as this binary will see it: tweakdroid's forced value, else
// the server value Droid last cached, else the factory default.
function effectiveFlag(name, flagsMap, source) {
  if (typeof flagsMap[name] === 'boolean') return flagsMap[name];
  const server = cachedServerFlags()[name];
  if (typeof server === 'boolean') return server;
  return parseFeatureFlags(source).find((f) => f.statsigName === name)?.enabled ?? false;
}

// Warn about Auto Model labels that would reach Factory's billed endpoint,
// following Droid 0.239.0's router:
// - Without native BYOK, the classifier is the first classifier label the
//   account may use (any label ahead of the first candidate can end up there),
//   and every candidate is a bare Factory id; the remap must cover them.
// - With native BYOK active (allowFactoryRouterByok true, custom
//   models allowed), the classifier is the first classifier label in Droid's
//   list that has an eligible BYOK model; one is enough. Without one, Droid
//   falls back to the account's first allowed classifier label (remap needed),
//   or with factoryRouterByokOnly it skips classification and takes the first
//   eligible candidate. Candidates with a BYOK model are routed to it; the rest
//   go to Factory, or with factoryRouterByokOnly are dropped (never billed).
function warnUnmappedRouterLabels(source, routerMap, flagsMap, dir) {
  const { candidates, classifiers, fastCandidates } = routerLabels(source);
  if (!candidates || !classifiers) {
    if (Object.keys(routerMap).length > 0) {
      console.warn('Warning: could not read Auto Model candidate labels from this binary; check router-byok-map.json keys by hand.');
    }
    return;
  }
  const fastOn = effectiveFlag('alloy_fast', flagsMap, source);
  const pool = [...candidates, ...(fastOn ? (fastCandidates ?? []).filter((id) => !candidates.includes(id)) : [])];
  const all = [...new Set([...classifiers, ...pool])];
  let native = { active: false, byokOnly: false, covered: new Set() };
  try {
    const status = nativeByokStatus(all, dir);
    const policy = status.policy.effective;
    const active = policy.allowFactoryRouterByok === true && policy.allowCustomModels !== false;
    native = {
      active,
      byokOnly: active && policy.factoryRouterByokOnly === true,
      covered: new Set(active ? all.filter((l) => status.assignments[l]) : []),
    };
  } catch (error) {
    console.warn(`Warning: could not read native BYOK settings (${error.message}); judging Auto Model coverage by the remap only.`);
  }
  if (Object.keys(routerMap).length === 0 && native.covered.size === 0) return;

  const firstCandidate = classifiers.findIndex((id) => candidates.includes(id));
  const classifierOnly = classifiers.slice(0, firstCandidate === -1 ? undefined : firstCandidate);
  const billed = [];
  const notes = [];
  const nativeClassifier = native.active ? classifiers.find((id) => native.covered.has(id)) : undefined;
  if (nativeClassifier && !classifierOnly.includes(nativeClassifier)) {
    notes.push(
      `the Auto Model classifier will run on the BYOK model for ${nativeClassifier} (the first label in Droid's classifier list with a BYOK model); assign one of ${classifierOnly.join(', ')} to use a cheaper model`
    );
  }
  if (!nativeClassifier) {
    if (native.byokOnly) {
      notes.push('no classifier label has a BYOK model, so Auto Model skips classification and uses the first eligible candidate');
    } else {
      billed.push(...classifierOnly.filter((id) => !routerMap[id]).map((id) => `${id} (classifier)`));
    }
  }
  const dropped = [];
  for (const id of pool) {
    if (native.covered.has(id)) continue;
    const tag = candidates.includes(id) ? id : `${id} (auto-fast)`;
    if (native.byokOnly) dropped.push(tag);
    else if (!routerMap[id]) billed.push(tag);
  }
  if (billed.length > 0) {
    console.warn(
      `Warning: neither router-byok-map.json nor native BYOK covers these Auto Model labels; if the router picks one it goes to Factory's billed endpoint:\n` +
        billed.map((id) => `  - ${id}`).join('\n')
    );
  }
  if (dropped.length > 0) notes.push(`factoryRouterByokOnly drops these candidates (no BYOK model): ${dropped.join(', ')}`);
  for (const note of notes) console.warn(`Note: ${note}.`);
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
  for (const [key, value] of Object.entries(obj)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`feature-flags.json: ${JSON.stringify(key)} is not a Statsig flag name`);
    if (typeof value !== 'boolean') throw new Error(`feature-flags.json: "${key}" must be true or false, got ${JSON.stringify(value)}`);
  }
  return obj;
}

// Binary patch: force Statsig feature flags on/off. Flipping a flag's
// defaultValue is not enough: the resolver consults
// FACTORY_FEATURE_FLAGS_OVERRIDES, the server store, and the disk cache before
// the default, so a server value (e.g. a flag Factory turns off for an org) wins.
// Two patches carry the same { statsigName: bool } map:
//  1. An override lookup at the very top of the resolver (the function that
//     destructures {statsigName, defaultValue} from its first parameter), so
//     tweakdroid's choices win for every check that goes through it, including
//     the ones that ignore FACTORY_FEATURE_FLAGS_OVERRIDES.
//  2. The same values applied to the server flag snapshot by the function that
//     merges FACTORY_FEATURE_FLAGS_OVERRIDES into every snapshot before Droid
//     stores or returns it. The patch makes that function apply the env
//     overrides and then tweakdroid's, and return (its original body stays,
//     unreachable, so removing the prefix restores it). Code that reads the
//     snapshot directly instead of asking the resolver (the awaited flag
//     fetch, the stored snapshot, flag-change listeners, the snapshot file
//     handed to child processes) then sees the forced values too. The disk
//     cache is written before this point, so it keeps the server's values.
// Absent flags fall through to normal resolution.
const FLAG_RESOLVER_HEAD = `function (${IDENT})\\((${IDENT})((?:,${IDENT})*)\\)\\{`;
const FLAG_RESOLVER_BODY = `(?=let\\{statsigName:${IDENT},defaultValue:${IDENT}\\}=\\2[,;])`;
const FLAG_SNAPSHOT_HEAD = `function (${IDENT})\\((${IDENT})\\)\\{`;
// Group 4 is the env-override reader.
const FLAG_SNAPSHOT_BODY =
  `(?=let (${IDENT})=(${IDENT})\\(\\);if\\(!\\3\\)return;for\\(let\\[(${IDENT}),(${IDENT})\\]of Object\\.entries\\(\\3\\)\\)\\2\\[\\5\\]=\\6\\})`;

function flagMapLiteral(flagsMap) {
  return (
    '{' +
    Object.entries(flagsMap)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k, v]) => `${JSON.stringify(k)}:${v ? '!0' : '!1'}`)
      .join(',') +
    '}'
  );
}

// Swap a uniquely matched function head between its factory form and a form
// with an injected prefix right after the opening brace. `patchedRe` and
// `origRe` must capture the same groups; `head(m)` rebuilds the factory head
// and `prefix(m)` the injected code ('' to remove it).
function swapFunctionHead(source, label, patchedRe, origRe, head, prefix) {
  const all = [...codeMatches(source, patchedRe), ...codeMatches(source, origRe)];
  if (all.length === 0) return { source, skipped: true };
  if (all.length > 1) throw new Error(`${label} is ambiguous (${all.length} matches)`);
  const [m] = all;
  const target = head(m) + prefix(m);
  if (m[0] === target) return { source, changed: false };
  return { source: source.slice(0, m.index) + target + source.slice(m.index + m[0].length), changed: true };
}

const FLAG_RESOLVER_PATCHED_RE = new RegExp(
  `${FLAG_RESOLVER_HEAD}let twdFF=\\{[^{}]*\\}\\[\\2\\.statsigName\\];if\\(twdFF!==void 0\\)return twdFF;${FLAG_RESOLVER_BODY}`,
  'g'
);
const FLAG_SNAPSHOT_PATCHED_RE = new RegExp(
  `${FLAG_SNAPSHOT_HEAD}let twdFS=\\{[^{}]*\\};Object\\.assign\\(\\2,${IDENT}\\(\\),twdFS\\);return;${FLAG_SNAPSHOT_BODY}`,
  'g'
);

function applyFeatureFlagsPatch(source, flagsMap, restore) {
  const literal = flagMapLiteral(flagsMap);
  const enabled = !restore && literal !== '{}';
  const resolver = swapFunctionHead(
    source,
    'Feature-flag resolver',
    FLAG_RESOLVER_PATCHED_RE,
    new RegExp(`${FLAG_RESOLVER_HEAD}${FLAG_RESOLVER_BODY}`, 'g'),
    (m) => `function ${m[1]}(${m[2]}${m[3]}){`,
    (m) => (enabled ? `let twdFF=${literal}[${m[2]}.statsigName];if(twdFF!==void 0)return twdFF;` : '')
  );
  // The snapshot patch is only meaningful next to the resolver patch.
  if (resolver.skipped) return { ...resolver, snapshotSkipped: true };
  const snapshot = swapFunctionHead(
    resolver.source,
    'Feature-flag snapshot override merger',
    FLAG_SNAPSHOT_PATCHED_RE,
    new RegExp(`${FLAG_SNAPSHOT_HEAD}${FLAG_SNAPSHOT_BODY}`, 'g'),
    (m) => `function ${m[1]}(${m[2]}){`,
    (m) => (enabled ? `let twdFS=${literal};Object.assign(${m[2]},${m[4]}(),twdFS);return;` : '')
  );
  return {
    source: snapshot.source,
    changed: Boolean(resolver.changed || snapshot.changed),
    snapshotSkipped: Boolean(snapshot.skipped),
  };
}

// The flag values Droid last fetched from Factory (its disk cache; written
// before tweakdroid's overrides apply), or {} when there is none.
function cachedServerFlags() {
  try {
    const home = process.env.FACTORY_HOME_OVERRIDE || os.homedir();
    const flags = JSON.parse(fs.readFileSync(path.join(home, '.factory', 'cache', 'feature-flags.json'), 'utf8'))?.flags;
    return flags && typeof flags === 'object' ? flags : {};
  } catch {
    return {};
  }
}

// Every flag in the binary with its factory default, the server value Droid
// last cached (null when unknown), and tweakdroid's forced value (null = not
// forced).
function listFlags(binaryPath, dir) {
  const source = restoreSource(getSource(binaryPath).source);
  const forced = readFeatureFlags(dir);
  const server = cachedServerFlags();
  const flags = parseFeatureFlags(source).map((f) => ({
    ...f,
    server: typeof server[f.statsigName] === 'boolean' ? server[f.statsigName] : null,
    forced: typeof forced[f.statsigName] === 'boolean' ? forced[f.statsigName] : null,
    ...(FLAG_NOTES[f.statsigName] ? { note: FLAG_NOTES[f.statsigName].text, needs: FLAG_NOTES[f.statsigName].needs ?? null } : {}),
  }));
  console.log(JSON.stringify(flags, null, 2));
}

function writeFeatureFlags(dir, obj) {
  const file = path.join(dir, 'feature-flags.json');
  fs.mkdirSync(dir, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
}

// --flag name=on|off|default: force a flag on or off, or stop forcing it.
function setFlags(binaryPath, dir, specs) {
  const known = new Set(parseFeatureFlags(restoreSource(getSource(binaryPath).source)).map((f) => f.statsigName));
  const flags = readFeatureFlags(dir);
  for (const spec of specs) {
    const m = /^([^=]+)=(on|off|true|false|default)$/.exec(spec);
    if (!m) throw new Error(`--flag expects name=on|off|default, got ${JSON.stringify(spec)}`);
    const [, name, value] = m;
    if (!known.has(name) && value !== 'default') {
      throw new Error(`This Droid build has no feature flag named ${name} (see --list-flags)`);
    }
    if (value === 'default') delete flags[name];
    else flags[name] = value === 'on' || value === 'true';
    console.log(`${name}: ${value === 'default' ? 'not forced (server/default decides)' : `forced ${flags[name] ? 'ON' : 'OFF'}`}`);
  }
  writeFeatureFlags(dir, flags);
  console.log('Saved feature-flags.json; run tweakdroid --apply to patch the binary.');
}

// Write the factory JS bundle (the binary restored in memory) to a file, for
// finding fingerprints and code patterns after a Droid update.
function dumpSource(binaryPath, file) {
  const source = restoreSource(getSource(binaryPath).source);
  fs.writeFileSync(file, source);
  console.log(`Wrote the factory Droid ${droidVersion(source) ?? ''} bundle (${source.length} chars) to ${file}`);
}

function listRouterLabels(binaryPath) {
  const source = restoreSource(getSource(binaryPath).source);
  console.log(JSON.stringify(routerLabels(source), null, 2));
}

// ---------------------------------------------------------------------------
// Hidden CLI commands and options
//
// Droid registers several working subcommands with `addCommand(cmd(),
// {hidden:!0})`, which only keeps them out of `droid --help`. Unhiding one
// rewrites that option to `{hidden:/*twd-unhide*/!1}`; the comment makes the
// patch self-describing, so restore flips every marked option back without any
// other state. `droid exec --help` is a hand-written template rather than
// commander output, so the Script-tool options are documented by splicing a
// `${"..."/*twd-exec-help*/}` expression into that template.

const UNHIDE_MARK = '/*twd-unhide*/';
const EXEC_HELP_MARK = '/*twd-exec-help*/';
const EXEC_HELP_RE = /\$\{"(?:[^"\\]|\\.)*"\/\*twd-exec-help\*\/\}/g;
const EXEC_HELP_ANCHOR = '\n  --list-tools                List available tools for the selected model and exit\n';

function readUnhide(dir) {
  const file = path.join(dir, 'unhide.json');
  if (!fs.existsSync(file)) return {};
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid unhide.json: ${error.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('unhide.json must be a JSON object of { "name": true|false }');
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'boolean') throw new Error(`unhide.json: "${key}" must be true or false`);
  }
  return obj;
}

function stripUnhide(source) {
  const next = source.replaceAll(`hidden:${UNHIDE_MARK}!1`, 'hidden:!0').replace(EXEC_HELP_RE, '');
  if (next.includes(UNHIDE_MARK) || next.includes(EXEC_HELP_MARK)) {
    throw new Error('Could not remove every unhide patch from this binary');
  }
  return next;
}

// Locate the `addCommand(<factory>(),{hidden:...})` call of subcommand `name`.
function hiddenCommandSite(source, name) {
  const defs = codeMatches(
    source,
    new RegExp(`function (${IDENT})\\(\\)\\{(?:let ${IDENT}=|return )new ${IDENT}\\(${escapeRegex(JSON.stringify(name))}\\)`, 'g')
  );
  if (defs.length > 1) throw new Error(`The "${name}" command is defined ${defs.length} times; cannot unhide it safely`);
  if (defs.length === 0) return { error: `no definition of the "${name}" command in this build` };
  const fn = escapeRegex(defs[0][1]);
  const sites = codeMatches(
    source,
    new RegExp(`\\.addCommand\\(${fn}\\(\\),\\{hidden:(?:!0|${escapeRegex(UNHIDE_MARK)}!1)\\}\\)`, 'g')
  );
  if (sites.length > 1) throw new Error(`The "${name}" command is registered ${sites.length} times; cannot unhide it safely`);
  if (sites.length === 0) return { error: `"${name}" is not registered as a hidden command in this build` };
  return { site: sites[0] };
}

// Apply unhide choices to restored (pristine) source. Returns the new source,
// the names unhidden, and per-name problems.
function applyUnhidePatch(source, choices) {
  let next = source;
  const done = [];
  const problems = [];
  for (const entry of HIDDEN_COMMANDS) {
    if (choices[entry.name] !== true) continue;
    if (entry.kind === 'command') {
      const { site, error } = hiddenCommandSite(next, entry.name);
      if (error) {
        problems.push(`${entry.name}: ${error}`);
        continue;
      }
      const patched = site[0].replace('{hidden:!0}', `{hidden:${UNHIDE_MARK}!1}`);
      next = next.slice(0, site.index) + patched + next.slice(site.index + site[0].length);
    } else if (entry.kind === 'exec-help') {
      const hits = codeMatches(next, new RegExp(escapeRegex(EXEC_HELP_ANCHOR), 'g'));
      if (hits.length > 1) throw new Error(`The droid exec help text has ${hits.length} --list-tools lines; cannot add the Script-tool options safely`);
      if (hits.length !== 1) {
        problems.push(`${entry.name}: the droid exec help text has ${hits.length} --list-tools lines (expected 1)`);
        continue;
      }
      // The anchor sits inside a template literal, so the insertion is an
      // expression of that template.
      const at = hits[0].index + 1;
      next = next.slice(0, at) + '${' + JSON.stringify(entry.helpText) + EXEC_HELP_MARK + '}' + next.slice(at);
    }
    done.push(entry.name);
  }
  return { source: next, done, problems };
}

const unhideState = (source) => ({
  commands: codeMatches(source, new RegExp(`\\.addCommand\\((${IDENT})\\(\\),\\{hidden:${escapeRegex(UNHIDE_MARK)}!1\\}\\)`, 'g'))
    .map((m) => m[1])
    .join(','),
  execHelp: source.includes(EXEC_HELP_MARK),
});

function listHidden(binaryPath, dir) {
  const source = restoreSource(getSource(binaryPath).source);
  const choices = readUnhide(dir);
  const rows = HIDDEN_COMMANDS.map((entry) => {
    let available = true;
    let problem = null;
    if (entry.kind === 'command') {
      const r = hiddenCommandSite(source, entry.name);
      available = !r.error;
      problem = r.error ?? null;
    } else {
      const n = source.split(EXEC_HELP_ANCHOR).length - 1;
      available = n === 1;
      if (!available) problem = `${n} --list-tools help lines`;
    }
    return { name: entry.name, kind: entry.kind, unhide: choices[entry.name] === true, available, problem, description: entry.description, needs: entry.needs ?? null };
  });
  console.log(JSON.stringify(rows, null, 2));
}

function setUnhide(dir, specs) {
  const known = new Set(HIDDEN_COMMANDS.map((e) => e.name));
  const choices = readUnhide(dir);
  for (const spec of specs) {
    const m = /^([^=]+)=(on|off|true|false)$/.exec(spec);
    if (!m) throw new Error(`--unhide expects name=on|off, got ${JSON.stringify(spec)}`);
    const [, name, value] = m;
    if (!known.has(name)) throw new Error(`Unknown hidden command ${name}; expected one of ${[...known].join(', ')}`);
    if (value === 'on' || value === 'true') choices[name] = true;
    else delete choices[name];
    console.log(`${name}: ${choices[name] ? 'shown after --apply' : 'hidden (factory)'}`);
  }
  const file = path.join(dir, 'unhide.json');
  fs.mkdirSync(dir, { recursive: true });
  if (Object.keys(choices).length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(choices, null, 2) + '\n');
  console.log('Saved unhide.json; run tweakdroid --apply to patch the binary.');
}

// ---------------------------------------------------------------------------
// Droid settings toggles (~/.factory/settings.json; see SETTINGS in catalog.mjs)

// KEY=unset removes a key; so does KEY=default where "default" is not itself a
// value of that key (outputStyle has a style named "default").
function parseSettingValue(entry, raw) {
  const accepts = entry.type === 'string' ? true : entry.type === 'enum' ? entry.values.includes(raw) : false;
  if (raw === 'unset' || (raw === 'default' && !accepts)) return undefined;
  if (entry.type === 'boolean') {
    if (['true', 'on'].includes(raw)) return true;
    if (['false', 'off'].includes(raw)) return false;
    throw new Error(`${entry.key} expects true or false (or unset to remove it)`);
  }
  if (entry.type === 'enum') {
    if (entry.values.includes(raw)) return raw;
    throw new Error(`${entry.key} expects one of ${entry.values.join(', ')} (or unset to remove it)`);
  }
  if (entry.type === 'string') {
    // Droid's schema: 1-1024 characters, no control characters.
    if (raw.length < 1 || raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw new Error(`${entry.key} must be 1-1024 characters without control characters`);
    }
    return raw;
  }
  throw new Error(`${entry.key} has unsupported type ${entry.type}`);
}

function settingRows() {
  const { data } = readFactorySettings();
  return SETTINGS.map((entry) => ({
    key: entry.key,
    value: getPath(data, entry.path) ?? null,
    droidDefault: entry.droidDefault ?? null,
    type: entry.type,
    values: entry.values ?? [true, false],
    flag: entry.flag ?? null,
    description: entry.description,
  }));
}

function listSettings() {
  console.log(JSON.stringify({ file: factorySettingsPath(), settings: settingRows() }, null, 2));
}

// `binaryPath` (optional) supplies flag defaults for the "needs flag" notes.
function setSettings(specs, binaryPath, dir) {
  const edits = [];
  for (const spec of specs) {
    const at = spec.indexOf('=');
    if (at === -1) throw new Error(`--setting expects KEY=VALUE, got ${JSON.stringify(spec)}`);
    const key = spec.slice(0, at);
    const entry = SETTINGS.find((e) => e.key === key);
    if (!entry) throw new Error(`Unknown setting ${key}; expected one of ${SETTINGS.map((e) => e.key).join(', ')}`);
    const value = parseSettingValue(entry, spec.slice(at + 1));
    edits.push({ path: entry.path, value, entry });
  }
  const { changed } = updateFactorySettings(edits.map(({ path: p, value }) => ({ path: p, value })));
  let source = null;
  try {
    if (binaryPath) source = restoreSource(getSource(binaryPath).source);
  } catch {
    source = null;
  }
  const forced = readFeatureFlags(dir);
  for (const { entry, value } of edits) {
    console.log(`${entry.key}: ${value === undefined ? `removed (Droid default: ${JSON.stringify(entry.droidDefault ?? null)})` : JSON.stringify(value)}`);
    if (!entry.flag || value === undefined) continue;
    const on = source ? effectiveFlag(entry.flag, forced, source) : forced[entry.flag] ?? cachedServerFlags()[entry.flag];
    if (on !== true) {
      console.log(`  note: Droid ${entry.flagEffect} unless the ${entry.flag} flag is on (--flag ${entry.flag}=on, then --apply)`);
    }
  }
  console.log(changed ? `Saved ${factorySettingsPath()}; restart Droid sessions to pick it up.` : 'settings.json already had these values.');
}

// ---------------------------------------------------------------------------
// Native Auto Model BYOK (gated by modelPolicy.allowFactoryRouterByok)

// Labels the native lookup runs for: every classifier id Droid tries and every
// candidate.
function nativeLabels(binaryPath) {
  const { candidates, classifiers, fastCandidates } = routerLabels(restoreSource(getSource(binaryPath).source));
  if (!candidates || !classifiers) throw new Error('Could not read the Auto Model labels from this binary');
  return [...new Set([...classifiers, ...candidates, ...(fastCandidates ?? [])])];
}

function nativeByokPrint(binaryPath, dir) {
  const labels = nativeLabels(binaryPath);
  const status = nativeByokStatus(labels, dir);
  console.log(JSON.stringify(status, null, 2));
  if (status.policy.effective.allowFactoryRouterByok !== true) {
    console.warn('Note: allowFactoryRouterByok is not true; set it with --setting modelPolicy.allowFactoryRouterByok=true.');
  }
}

// Unassigning needs no binary (it is the recovery path); assigning validates
// the label against the binary.
function nativeByokEdit(binaryPath, dir, assigns, unassigns) {
  for (const label of unassigns) {
    const removed = unassignNativeByok(label, dir);
    console.log(removed.length ? `${label}: no longer routed natively (${removed.join(', ')})` : `${label}: had no native BYOK model`);
  }
  const labels = assigns.length > 0 ? nativeLabels(binaryPath) : [];
  for (const spec of assigns) {
    const at = spec.indexOf('=');
    if (at === -1) throw new Error(`--native-byok-assign expects LABEL=custom:ID, got ${JSON.stringify(spec)}`);
    const r = assignNativeByok(spec.slice(0, at), spec.slice(at + 1), labels, dir);
    console.log(
      `${spec.slice(0, at)} -> ${r.id}${r.copied ? ' (a copy: that model already serves another label, and a custom model holds one baseModelId)' : ''}`
    );
  }
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
  const unhide = applyUnhidePatch(next, readUnhide(dir));
  next = unhide.source;
  return { next, factory, edits, router, noComments, remap, routerMap, flagsMap, flags, unhide };
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
    else if (built.flags.snapshotSkipped && Object.keys(built.flagsMap).length > 0) {
      notes.push('(feature-flag snapshot override merger not found; forced flags apply only to checks that go through the resolver)');
    }
    for (const problem of built.unhide.problems) console.warn(`Warning: cannot unhide ${problem}; skipped.`);
    warnUnmappedRouterLabels(base, built.routerMap, built.flagsMap, dir);
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
  const snapshotText = (s) => /let twdFS=(\{[^{}]*\})/.exec(s)?.[1] ?? '';
  if (flagsText(source) !== flagsText(next)) {
    const forced = flagsText(next);
    rows.push(forced ? `(feature flags forced: ${forced})` : '(feature-flag overrides removed)');
  } else if (snapshotText(source) !== snapshotText(next)) {
    rows.push(snapshotText(next) ? '(forced feature flags: server-snapshot override added)' : '(server-snapshot flag override removed)');
  }

  const hiddenBefore = unhideState(source);
  const hiddenAfter = unhideState(next);
  if (hiddenBefore.commands !== hiddenAfter.commands) {
    const count = (s) => (s ? s.split(',').length : 0);
    rows.push(`(hidden commands shown in droid --help: ${count(hiddenBefore.commands)} -> ${count(hiddenAfter.commands)})`);
  }
  if (hiddenBefore.execHelp !== hiddenAfter.execHelp) {
    rows.push(`(Script-tool options in droid exec --help: ${hiddenAfter.execHelp ? 'added' : 'removed'})`);
  }

  const changed = next !== source;
  if (changed) {
    assertParses(next, base);
    // Every patch must stay removable from the binary alone.
    if (!restore && restoreSource(next) !== base) {
      throw new Error('Internal error: the patched bundle would not restore to the factory bundle; binary left untouched.');
    }
  }
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

// Refuse to write a binary whose patched modules would not even parse.
function assertParses(js, base) {
  const factory = new Map(splitBundle(base));
  for (const [name, text] of splitBundle(js)) {
    if (factory.get(name) === text) continue;
    const file = path.join(os.tmpdir(), `tweakdroid-check-${process.pid}.mjs`);
    fs.writeFileSync(file, text);
    try {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`Patched Droid module ${name} does not parse; binary left untouched.\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
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
  const actions = [
    args.extract, args.apply, args.restore, args.listFlags, args.listRouterLabels, args.listHidden,
    args.listSettings, args.nativeStatus, args.dumpSource, args.flag.length, args.setting.length,
    args.unhide.length, args.nativeAssign.length, args.nativeUnassign.length,
  ].filter(Boolean).length;
  if (actions === 0) {
    // No action flags: launch the interactive TUI.
    launchTui(process.argv.slice(2));
    return;
  }
  const dir = path.resolve(args.dir);
  // Edits (--flag, --unhide, --setting, --native-byok-*) run first, in that
  // order; then at most one other action runs.
  const others = [
    args.extract, args.apply, args.restore, args.listFlags, args.listRouterLabels, args.listHidden,
    args.listSettings, args.nativeStatus, args.dumpSource,
  ].filter(Boolean).length;
  if (others > 1) {
    console.error('Pick one of --extract, --apply, --restore, --list-*, --native-byok, --dump-source per run (edits may be combined with it).');
    process.exit(1);
  }
  if (args.dryRun && !(args.apply || args.restore)) throw new Error('--dry-run only goes with --apply or --restore');
  if (args.dryRun && (args.flag.length || args.unhide.length || args.setting.length || args.nativeAssign.length || args.nativeUnassign.length)) {
    throw new Error('--dry-run cannot be combined with edits; run the edit first, then --apply --dry-run');
  }
  const needsBinary = (others > 0 && !args.listSettings) || args.flag.length || args.nativeAssign.length;
  const binary = needsBinary ? path.resolve(args.binary || defaultDroidPath()) : optionalBinary(args.binary);
  if (args.flag.length) setFlags(binary, dir, args.flag);
  if (args.unhide.length) setUnhide(dir, args.unhide);
  if (args.setting.length) setSettings(args.setting, binary, dir);
  if (args.nativeUnassign.length || args.nativeAssign.length) nativeByokEdit(binary, dir, args.nativeAssign, args.nativeUnassign);
  if (args.listFlags) return listFlags(binary, dir);
  if (args.listRouterLabels) return listRouterLabels(binary);
  if (args.listHidden) return listHidden(binary, dir);
  if (args.listSettings) return listSettings();
  if (args.nativeStatus) return nativeByokPrint(binary, dir);
  if (args.dumpSource) return dumpSource(binary, path.resolve(args.dumpSource));
  if (args.extract) extract(binary, dir);
  if (args.apply || args.restore) {
    apply(binary, dir, args.output && path.resolve(args.output), args.dryRun, Boolean(args.restore));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
