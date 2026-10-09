// What tweakdroid knows about Droid's toggles, shared by the CLI and the TUI.
// Facts here were read from the Droid 0.211.0 bundle; re-check them when you
// bump Droid (see .claude/skills/bump-droid-version).

// Subcommands Droid registers with {hidden:!0} (they work when typed; hiding
// only keeps them out of `droid --help`), plus the Script-tool options that
// `droid exec --help` leaves out.
export const HIDDEN_COMMANDS = [
  {
    name: 'statusline-probe',
    kind: 'command',
    description: 'Runs your configured statusLine command once under Droid\'s 5 s budget and prints the result as JSON (local; the /statusline agent uses it).',
  },
  {
    name: 'rules',
    kind: 'command',
    description: '`droid rules check [--file] [--json]` validates your Execute-command permission rules and runs their self-tests (local).',
  },
  {
    name: 'wiki-read',
    kind: 'command',
    description: 'Prints the Factory wiki page tree or one page for a repository.',
    needs: 'the wiki flag (on by default) and Factory wiki access for the repository',
  },
  {
    name: 'wiki-search',
    kind: 'command',
    description: 'Searches a repository\'s Factory wiki.',
    needs: 'the wiki flag (on by default) and Factory wiki access for the repository',
  },
  {
    name: 'wiki-upload',
    kind: 'command',
    description: 'Uploads a markdown wiki directory to Factory and/or GitHub (`--check` only reports whether the wiki feature is enabled).',
    needs: 'the wiki flag (on by default) and Factory wiki access for the repository',
  },
  {
    name: 'software-factory',
    kind: 'command',
    description: '`droid software-factory` (alias `sf`): about 50 subcommands for the Software Factory data model (workstreams, signals, goals, memory, dashboards).',
    needs: 'Software Factory enabled for your Factory organization (the server answers 403 otherwise; no client flag changes that)',
  },
  {
    name: 'exec-script-options',
    kind: 'exec-help',
    description: 'Lists --tool-execution-mode and --[no-]allow-subagents-in-scripts in `droid exec --help` (they are accepted either way).',
    needs: 'the script_tools flag; without it Droid silently runs direct_only',
    helpText:
      '  --tool-execution-mode <mode>  direct-only | direct-and-script | script-only (needs the script_tools flag)\n' +
      '  --[no-]allow-subagents-in-scripts  Allow Task calls from Script (needs the script_tools flag)\n',
  },
];

// Notes for the flags worth knowing about, in the order the TUI lists them.
// `needs` names what else must be true for the flag to change anything.
export const FLAG_NOTES = {
  alloy: {
    text: 'Auto Model: adds the "auto" model, which asks a classifier which candidate model to use for each turn.',
    needs: 'access to the candidate models: Factory entitlement, or the Model Router remap / native BYOK',
  },
  alloy_byok: {
    text: 'Auto Model Full BYOK: Droid routes a label to the custom model that has useInRouter: true and baseModelId: <label> (Native BYOK view).',
    needs: 'alloy, and modelPolicy.allowFactoryRouterByok: true in settings.json',
  },
  alloy_fast: {
    text: 'Adds the "auto-fast" model (Auto Model over the fast model variants).',
    needs: 'alloy',
  },
  automations_v2: {
    text: 'Local /automations command plus the Create/List/Read/Edit/Delete Automation tools.',
  },
  script_tools: {
    text: 'Script tool (and WaitForScript): the model can call tools from a JavaScript program. Checked when a session is created.',
    needs: 'toolExecutionMode set to direct_and_script or script_only (Droid Settings view, /settings, or exec --tool-execution-mode); resumed sessions keep the mode they were created with',
  },
  communication_prompt_v2: {
    text: 'Swaps the "# Communication" section of the main prompt for the longer v2 rules (prompt file 61 instead of 60). Works in TUI, ACP, and exec.',
  },
  output_style_setting: {
    text: 'Appends the selected output style (built-in "concise", or your output-styles/*.md) as the last system block, and shows Output style in /settings.',
    needs: 'outputStyle set to something other than "default"; only interactive TUI sessions use it (not exec, ACP, or subagents)',
  },
  one_hour_anthropic_caching: {
    text: 'Marks the last system block and last tool with a 1-hour Anthropic cache TTL instead of 5 minutes. In daemon sessions it also sends a background prompt-cache promotion request 270 s after a turn (an extra model call).',
    needs: 'enableOneHourAnthropicCaching: true in settings.json',
  },
  cli_rules_engine: {
    text: 'Execute-command allow/ask/block checks use the compiled rules engine (built-in rules, your allow/deny lists, and optional permissionRules) instead of the legacy list matcher. `droid rules check` validates rules either way.',
  },
  mid_conversation_tool_changes: {
    text: 'When tools load mid-session (ToolSearch/MCP deferred tools), sends them without breaking the prompt cache (Anthropic beta defer_loading; OpenAI tool_search items).',
    needs: 'deferred tools in use and a supported built-in model; Anthropic BYOK customs are excluded, GPT-5.4+ customs are included (your proxy must accept tool_search items)',
  },
  'droid_shield_2.0': {
    text: 'Droid Shield 2.0: before git commit/push, also asks Factory-hosted risk classifiers (not just the secret scan), and scans background git commands too.',
    needs: 'enableDroidShield (on by default) and Factory backend access; without it the classifier call fails and the plain secret scan decides',
  },
  wiki: {
    text: 'On by default. Built-in wiki skills and the wiki-read/search/upload commands; forcing it OFF removes both.',
  },
  git_ai: {
    text: '/git-ai command and git-ai hook auto-setup (with git_ai_auto_setup).',
  },
  software_factory: {
    text: 'Built-in Software Factory skills.',
    needs: 'Software Factory enabled for your Factory organization (backend)',
  },
  independent_command_risk_classification: {
    text: 'Observation only: after each risky tool call Droid asks gpt-5.6-luna to rate the risk and only logs the answer. It never changes a permission decision; forcing it ON just adds hidden model calls.',
  },
  nested_task_delegation: {
    text: 'In 0.211.0 the nesting depth is clamped to 1, so subagents still cannot spawn subagents; turning it ON only adds concurrency limits (5 active descendants per root, 10 Task subagents per daemon).',
  },
};

// Droid settings that are plain keys of ~/.factory/settings.json (flat: the
// file's top level is Droid's "general" settings). droidDefault is Droid's
// built-in value when the key is absent; flag is the Statsig flag without
// which Droid ignores the setting.
export const SETTINGS = [
  {
    key: 'toolExecutionMode',
    path: ['toolExecutionMode'],
    type: 'enum',
    values: ['direct_only', 'direct_and_script', 'script_only'],
    droidDefault: 'direct_only',
    flag: 'script_tools',
    flagEffect: 'runs every session direct_only',
    description:
      'How the model calls tools in new sessions: direct_only (normal tool calls), direct_and_script (normal calls plus the Script tool), script_only (only Script and a few lifecycle tools).',
  },
  {
    key: 'allowSubagentsInScripts',
    path: ['allowSubagentsInScripts'],
    type: 'boolean',
    droidDefault: false,
    flag: 'script_tools',
    flagEffect: 'ignores it',
    description: 'Lets Script programs call the Task tool (subagents). Only matters when toolExecutionMode is not direct_only.',
  },
  {
    key: 'outputStyle',
    path: ['outputStyle'],
    // Any style id: "default", the built-in "concise", or a custom style's id.
    type: 'string',
    values: ['default', 'concise'],
    droidDefault: 'default',
    flag: 'output_style_setting',
    flagEffect: 'ignores it',
    description:
      'Output style appended to the system prompt in interactive TUI sessions. "default" adds nothing, "concise" is built in (prompt file 70). Custom styles live in ~/.factory/output-styles/*.md; pick one in Droid\'s /settings, or set its id here (--setting outputStyle=<id>). unset removes the key.',
  },
  {
    key: 'enableOneHourAnthropicCaching',
    path: ['enableOneHourAnthropicCaching'],
    type: 'boolean',
    droidDefault: false,
    flag: 'one_hour_anthropic_caching',
    flagEffect: 'ignores it',
    description: '1-hour Anthropic prompt-cache TTL on the system prompt and tools (see the one_hour_anthropic_caching flag for the extra background request it adds in daemon sessions).',
  },
  {
    key: 'enableDroidShield',
    path: ['enableDroidShield'],
    type: 'boolean',
    droidDefault: true,
    description: 'Droid Shield secret scanning before git commit/push (Droid 2.0 classifiers on top when the droid_shield_2.0 flag is on).',
  },
  {
    key: 'modelPolicy.allowFactoryRouterByok',
    path: ['modelPolicy', 'allowFactoryRouterByok'],
    type: 'boolean',
    droidDefault: false,
    flag: 'alloy_byok',
    flagEffect: 'never looks for BYOK router models',
    description:
      'Model-policy gate for native Auto Model BYOK: Droid only uses custom models marked useInRouter/baseModelId when this is true. An org policy that sets it wins over this file.',
  },
  {
    key: 'modelPolicy.factoryRouterByokOnly',
    path: ['modelPolicy', 'factoryRouterByokOnly'],
    type: 'boolean',
    droidDefault: false,
    flag: 'alloy_byok',
    flagEffect: 'ignores it',
    description:
      'Native BYOK only: Auto Model drops every label that has no BYOK model (and skips Factory classifiers), so nothing goes to Factory\'s billed endpoint. With one eligible candidate Droid skips the classifier entirely.',
  },
];
