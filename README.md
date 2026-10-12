# tweakdroid

Extract, edit, restore, and re-apply Factory Droid system prompts, and turn on
the Droid features hidden behind flags, settings, and hidden commands.

`tweakdroid` patches the prompt text embedded in the local Droid binary. It is
for people who want real prompt replacement instead of append-only overrides.
It also forces feature flags, routes Auto Model through your own models, and
edits the settings those features need.

Supported Droid version: **0.239.0** (macOS Mach-O and Linux ELF). Droid 0.239
ships as hundreds of code-split modules with precompiled bytecode (Bun 1.4);
tweakdroid patches the modules it needs and leaves the rest as shipped. Droid
0.211 rebuilt its system prompt from sections, so this release does not patch
Droid 0.153 or older; use an older tweakdroid commit for those.

## What it does

- Extracts Droid prompt blocks into Markdown files.
- Extracts the runtime-injected reminders and notifications, mission prompts, and
  side-model prompts (Auto Model classifier, risk classifier) too.
- Keeps extracted defaults separate from edited prompts.
- Lets Anthropic, OpenAI, and Google use different `01` and `02` prompts.
- Applies edits back into the Droid binary.
- Restores the binary back to extracted defaults without deleting edits.
- Supports dry-runs; patches the Droid binary in place.
- Routes Factory Router (Auto Model) through your own BYOK custom models, either
  with tweakdroid's remap or with Droid's native Auto Model BYOK.
- Forces any Statsig feature flag on or off, over the server value, for every
  code path that reads it.
- Edits the Droid settings those features need (`toolExecutionMode`,
  `outputStyle`, `modelPolicy`, …) in `~/.factory/settings.json`, safely.
- Shows Droid's hidden subcommands in `droid --help`.
- Ships an interactive terminal UI for all of the above, and a skill that walks
  you (or your agent) through bumping tweakdroid to a new Droid version.

## Install

```bash
git clone https://github.com/skrabe/tweakdroid.git
cd tweakdroid
pnpm install
pnpm link --global
```

After linking, run:

```bash
tweakdroid --help
```

Without global linking, use:

```bash
pnpm tweakdroid --help
```

## Interactive UI

Run `tweakdroid` with no arguments (or `pnpm ui` / `tweakdroid-ui`) to launch a
terminal UI built with Ink. No build step — it runs straight from source. It
takes the same `--binary` and `--dir` arguments as the CLI.

```bash
tweakdroid          # launches the TUI
```

Seven views, driven with the arrow keys:

- **Model Router** — map each Auto Model label (read from the installed binary)
  and the classifier to one of your `~/.factory` custom models (tweakdroid's
  remap, see below). Flags malformed (dotted-name) models.
- **Native Auto BYOK** — Droid's own Auto Model BYOK: the `modelPolicy` gate
  and which custom model serves each label.
- **Feature Flags** — force any of Droid's ~120 Statsig flags ON or OFF (space
  cycles not forced → ON → OFF). Shows the server's last value, the factory
  default, and notes on what the notable flags do and what else they need.
- **Droid Settings** — the `settings.json` keys behind those features.
- **Hidden Commands** — list hidden subcommands in `droid --help`.
- **System Prompts** — open prompt overrides in your editor; revert to factory.
- **Apply / Status** — dry-run, apply, restore, or re-extract.

Model Router, Feature Flags, Hidden Commands, and System Prompts only write
tweakdroid's config files (`router-byok-map.json`, `feature-flags.json`,
`unhide.json`, `edited-prompts/`); nothing touches the binary until you run
**Apply** (which is just `tweakdroid --apply`). Droid Settings and the policy
and model rows of Native Auto BYOK write `~/.factory/settings.json` right away.

## Prompt folders

By default, `tweakdroid` uses:

```text
~/.tweakdroid/system-prompts
~/.tweakdroid/edited-prompts
```

`system-prompts` contains prompts extracted from your currently installed Droid
binary. `edited-prompts` contains your overrides. `--apply` reads
`edited-prompts/<filename>` when it exists and falls back to
`system-prompts/<filename>` when it does not.

`--extract` refreshes `system-prompts` (removing files for prompts the
installed Droid no longer has) and creates `edited-prompts` if needed, but it
never creates, edits, or deletes prompt files inside `edited-prompts`. On a
binary that already carries tweakdroid patches it extracts from the restored
factory text (computed in memory), so your edits never land in
`system-prompts`.

Both `--extract` and `--apply` warn about edited prompts that match no prompt in
the installed Droid (removed upstream), and about edited prompts whose factory
text changed since you wrote them, so you know which overrides to review after a
Droid update. `--apply` and `--restore` read factory text from the binary
itself, not from `system-prompts`, so they work even when `system-prompts` is
missing or stale; `--apply` only warns when it came from another Droid version.

## Included prompts

This repository includes my current edited prompts in:

```text
prompts/edited-prompts
```

They are `02-main-interactive` for Anthropic and for OpenAI models,
`03-exec-noninteractive`, and the Gemini-only `08-google-execute-cli-risk`.
Everything else uses Droid's factory text.

These prompts are specialized for **GPT-5.5** and **Claude Opus 4.8**. They
should not be used with other AI models unless you review and retune them first.

To use the included prompts:

```bash
tweakdroid --extract
cp prompts/edited-prompts/*.md ~/.tweakdroid/edited-prompts/
tweakdroid --apply --dry-run
tweakdroid --apply
```

## Get fresh prompts for your Droid version

If you want clean prompts from your installed Droid instead of the included
edited prompts, delete the contents of the local prompt folders and extract
again:

```bash
rm -f ~/.tweakdroid/system-prompts/*.md ~/.tweakdroid/system-prompts/manifest.json
rm -f ~/.tweakdroid/edited-prompts/*.md
tweakdroid --extract
```

Then either edit files manually, or copy selected files from
`system-prompts` into `edited-prompts` and edit those copies.

## Commands

Extract prompts:

```bash
tweakdroid --extract
```

Dry-run edited prompts:

```bash
tweakdroid --apply --dry-run
```

Apply edited prompts:

```bash
tweakdroid --apply
```

Restore the factory binary (removes every tweakdroid patch, including forced
flags and unhidden commands) without touching `edited-prompts` or any config:

```bash
tweakdroid --restore
```

Dry-run restore:

```bash
tweakdroid --restore --dry-run
```

Use a custom prompt folder:

```bash
tweakdroid --extract --dir /path/to/tweakdroid-folder
tweakdroid --apply --dir /path/to/tweakdroid-folder
```

Patch a specific Droid binary:

```bash
tweakdroid --apply --binary /path/to/droid
```

Write a patched copy instead of modifying the original:

```bash
tweakdroid --apply --output /path/to/patched-droid
```

List the binary's Statsig feature flags as JSON (factory default, the value
Droid last cached from the server, and what tweakdroid forces):

```bash
tweakdroid --list-flags
```

Force flags (saved to `feature-flags.json`; `--apply` patches them in):

```bash
tweakdroid --flag alloy_fast=on --flag nested_task_delegation=off --flag cli_rules_engine=default
tweakdroid --apply
```

Show hidden subcommands in `droid --help` (saved to `unhide.json`):

```bash
tweakdroid --list-hidden
tweakdroid --unhide statusline-probe=on --unhide rules=on
tweakdroid --apply
```

Read and change Droid settings (written to `~/.factory/settings.json` at once;
`unset` removes the key so Droid's default applies; `default` does the same,
except for `outputStyle`, which has a style named `default`):

```bash
tweakdroid --list-settings
tweakdroid --setting toolExecutionMode=script_only --setting outputStyle=concise
tweakdroid --setting outputStyle=unset
```

Native Auto Model BYOK:

```bash
tweakdroid --native-byok                                   # status
tweakdroid --native-byok-assign claude-opus-5=custom:My-Opus-3
tweakdroid --native-byok-unassign claude-opus-5
```

Write the factory JS bundle to a file (for finding fingerprints and code
patterns after a Droid update):

```bash
tweakdroid --dump-source /tmp/droid.js
```

Edits (`--flag`, `--unhide`, `--setting`, `--native-byok-*`) can be combined
with one other action, and run first: `tweakdroid --flag alloy_fast=on --apply`.

List the model labels Auto Model can emit as JSON: its candidates, the ordered
classifier list, and the `-fast` candidates Auto Model Fast uses:

```bash
tweakdroid --list-router-labels
```

## Factory Router on your BYOK models

Factory Router ("Auto Model") asks a classifier model to score a list of
candidate models for each turn, then routes the turn to the cheapest candidate
that scores high enough. Every one of those calls goes to Factory-hosted models,
which fail with 402 if your account has no Factory subscription. tweakdroid
reroutes the router's calls (its classifier and the model it picks) to your
`~/.factory` BYOK custom models, so Auto Model runs on your subscriptions.

It works by remapping model ids at the top of Droid's custom-model resolver. The
mapping lives in `~/.tweakdroid/router-byok-map.json`: Factory model id →
one of your `custom:` ids. Droid 0.239.0 emits these labels:

- candidates: `claude-opus-5-5`, `gpt-6.1-sol`, `kimi-k3`, `glm-5.3`,
  `gpt-6-luna`, `deepseek-v4.1-flash`, `minimax-m3`
- classifier: the first id the account may use from `gpt-5.4-mini-fast`,
  `gpt-5.4-mini`, `gpt-6-luna`, `gpt-5.6-luna`, `claude-haiku-4-5-20251001`,
  `glm-5.3`, …
- auto-fast (only with the `alloy_fast` flag): `claude-opus-5-5-fast`

```json
{
  "claude-opus-5-5": "custom:CC:-Opus-4.8-(Max)-36",
  "gpt-6.1-sol": "custom:GPT-5.5-(High)-41",
  "kimi-k3": "custom:GPT-5.5-(High)-41",
  "glm-5.3": "custom:GPT-5.5-(High)-41",
  "gpt-6-luna": "custom:GPT-5.3-Codex-Spark-43",
  "deepseek-v4.1-flash": "custom:GPT-5.3-Codex-Spark-43",
  "minimax-m3": "custom:GPT-5.3-Codex-Spark-43",
  "gpt-5.4-mini-fast": "custom:GPT-5.4-Mini-84",
  "gpt-5.4-mini": "custom:GPT-5.4-Mini-84"
}
```

Labels change between Droid versions, and an unmapped label silently falls
through to Factory's billed endpoint. `--apply` therefore reads the labels from
the binary and warns about any candidate or classifier (and, when `alloy_fast`
is on, `-fast` label) that neither this map nor native BYOK covers;
`tweakdroid --list-router-labels` prints them. Keys for labels a version no
longer emits are harmless, so keep old keys if you switch between versions.
Factory can also replace the candidate list at runtime (the
`factory_router_candidates` dynamic config), which no static check can see.

Every value must be a `custom:` id exactly as Droid reports it (run
`droid exec -m x --list-tools` to list them). Edit the file directly or use the
**Model Router** view, then `--apply`. An empty/absent file leaves the router
untouched. Droid 0.239 always offers Auto Model (`auto`); force the
`alloy_fast` flag below for `auto-fast`.
Droid also has a native BYOK mode for Auto Model; see
[Native Auto Model BYOK](#native-auto-model-byok) for how the two combine.

## Feature flags

Droid gates preview features behind Statsig flags (`alloy_fast` = the
`auto-fast` model, `automations_v2` = local `/automations`, …).
`~/.tweakdroid/feature-flags.json` maps `statsigName → true|false`: `true`
forces the flag ON, `false` forces it OFF, and a flag that is not listed is left
to the server and Droid's default.

```json
{ "alloy": true, "automations_v2": true }
```

Flipping a flag's `defaultValue` is not enough, because Droid asks the server
first. `--apply` installs two patches that carry the same map:

1. An override at the top of Droid's flag resolver, so every check that goes
   through the resolver (and the React hook built on it) gets your value, even
   the checks that ignore `FACTORY_FEATURE_FLAGS_OVERRIDES`.
2. The same values merged into Droid's server flag snapshot, in the function
   that applies `FACTORY_FEATURE_FLAGS_OVERRIDES` to every snapshot before
   Droid stores or returns it. Code that reads the snapshot directly (the wiki
   commands, `/help`, `/git-ai`, the daemon model catalog, flag-change
   listeners, the snapshot file passed to child processes) sees your values too.

Precedence is tweakdroid > `FACTORY_FEATURE_FLAGS_OVERRIDES` > server >
default. Droid's own `FACTORY_FEATURE_FLAGS_OVERRIDES='{"flag":true}'`
environment variable still works for flags tweakdroid does not force, which
makes it handy for one-off experiments without re-applying. The disk cache
(`~/.factory/cache/feature-flags.json`) keeps the server's values; tweakdroid
reads it only to show them. `--restore` removes both patches.

Forcing a flag changes only what this Droid binary believes. It cannot help
with checks Factory's servers make (Droid Shield 2.0 classifiers, the wiki API,
Software Factory, cloud automations), with Factory computers or remote workers
(they run an unpatched Droid), or with Factory's dynamic configs (separate from
flags). Some flags also need a setting; see the table below.

## Native Auto Model BYOK

Droid 0.239.0 has its own BYOK mode for Auto Model ("Auto Model Full BYOK"; its
`alloy_byok` flag is no longer read). For each Auto Model label (a built-in
model id such as `claude-opus-5-5`), Droid uses the first custom model in `settings.json` that has
`"useInRouter": true` and `"baseModelId": "<label>"`, for candidates, the
classifier, and the fallback. It only looks when the merged model policy has
`"allowFactoryRouterByok": true`. With `"factoryRouterByokOnly": true` it also
drops every label without a BYOK model (and with a single eligible candidate it
skips the classifier call entirely). A natively routed candidate is eligible
even without Factory entitlement for the underlying model.

To use it:

```bash
tweakdroid --setting modelPolicy.allowFactoryRouterByok=true
tweakdroid --native-byok-assign claude-opus-5-5=custom:My-Opus-3
tweakdroid --native-byok-assign gpt-5.4-mini-fast=custom:My-Mini-7   # classifier
tweakdroid --native-byok                                          # check
```

or use the **Native Auto BYOK** view. A custom model holds one `baseModelId`, so
when you route a second label to a model that already serves one, tweakdroid
adds a copy of that entry named `<name> [Auto <label>]` and records it in
`~/.tweakdroid/native-byok.json`. Unassigning a label strips `useInRouter` and
`baseModelId` from your own entries and deletes only those recorded copies;
tweakdroid never removes any other custom model. Copies are snapshots: if you
change the source model (base URL, key), assign the label again.

Labels include every classifier label, every candidate, and the `-fast`
variants Auto Model Fast (`alloy_fast`) uses. The status reads your
`settings.json` and Droid's cached org policy (each key the org policy sets wins
over your file; project-level `.factory/settings.json` files are not read) and
applies Droid's own eligibility rules: with `allowCustomModels: false` no custom
model is used, and with `allowedBaseUrls` a custom model whose base URL is not
listed (same origin, same or deeper path) is skipped. tweakdroid refuses to
assign such a model and reports configured entries Droid would skip. It cannot
check Bedrock customs against `allowedBaseUrls` (Droid derives their endpoint
from AWS settings) and marks them as unverified.

### Remap or native: which one wins

Both can be on at once. Droid resolves native assignments first: a natively
routed label reaches the custom-model resolver already as a `custom:` id, so
tweakdroid's remap never touches it. The remap then catches every label that is
still a bare Factory id (unless `factoryRouterByokOnly` dropped it). For the
classifier, one BYOK classifier label is enough: Droid uses the first label in
its classifier list that has an eligible BYOK model. Without one it falls back
to the first classifier label the account may use (which the remap can cover),
or, with `factoryRouterByokOnly`, skips classification and takes the first
eligible candidate. `--apply` follows the same rules: it warns about labels that
would reach Factory's billed endpoint and notes the candidates
`factoryRouterByokOnly` drops. In short:

| | tweakdroid remap | native BYOK |
|---|---|---|
| Where | binary patch + `router-byok-map.json` | `settings.json` fields |
| One model for many labels | yes | one label per entry (tweakdroid adds copies) |
| Candidates need Factory entitlement | yes | no |
| Unmapped labels | go to Factory (billed) | go to Factory, or are dropped with `factoryRouterByokOnly` |
| Survives a Droid update | after `--apply` | yes (settings), flag re-applied by `--apply` if forced |

## Droid settings

Some features are plain keys of `~/.factory/settings.json` (Droid reads the
file as JSONC; its top level is Droid's general settings). tweakdroid edits
them there instead of patching the binary. Values are set with jsonc-parser,
which keeps the other keys and comments but may re-indent the object it inserts
into (a one-line object becomes multi-line). Removing a key drops only that
property, the comment lines directly above it, a comment after it on its line,
and the comma it needs. A key that occurs twice on the path is refused (Droid
uses the last occurrence; fix it by hand). A file that does not parse is never
rewritten, and the write is refused if the number of custom models would
change unexpectedly.

Droid writes `settings.json` without a cross-process lock (it re-reads
the file before each save and replaces it with a temp file and rename).
tweakdroid takes its own lock file (`settings.json.twd.lock`, against other
tweakdroid processes), bases every edit on the bytes it read, re-checks the
file's inode, size, mtime, and content right before its own rename and aborts
if anything changed, and re-reads the file afterwards to detect a writer that
landed at the same moment. A Droid save in the microseconds between that last
check and the rename would still be overwritten, and a running Droid also keeps
settings in memory, so change settings with no Droid session open, or restart
Droid afterwards.

| Key | Values (Droid default) | Needs flag | What it does |
|---|---|---|---|
| `toolExecutionMode` | `direct_only`, `script_only` (`script_only` for models on Factory's `script_tool_models` list, else `direct_only`) | — | How new sessions call tools: normal calls, or most tools only inside the Script tool. Only models on Factory's server-side `script_tool_models` list honor it; every other model runs `direct_only`. |
| `allowSubagentsInScripts` | bool (`false`) | — | Lets Script call the Task tool in `script_only` sessions. |
| `outputStyle` | `default`, `concise`, or a custom style id (`default`) | `output_style_setting` | Appends the style to the system prompt in interactive TUI sessions (not exec, ACP, subagents). Custom styles: `~/.factory/output-styles/*.md`, picked in Droid's `/settings` or set by id with `--setting outputStyle=<id>`. |
| `enableOneHourAnthropicCaching` | bool (`false`) | `one_hour_anthropic_caching` | 1-hour Anthropic cache TTL on the system prompt and tools. |
| `enableDroidShield` | bool (`true`) | — | Secret scan before git commit/push (`droid_shield_2.0` adds classifiers). |
| `modelPolicy.allowFactoryRouterByok` | bool (`false`) | — | Gate for native Auto Model BYOK. |
| `modelPolicy.factoryRouterByokOnly` | bool (`false`) | — | Native BYOK only; nothing falls through to Factory. |

## Hidden commands

Droid registers several working subcommands as hidden: they run when you type
them, but `droid --help` does not list them. `--unhide NAME=on` (or the
**Hidden Commands** view) lists them after `--apply`; the patch rewrites the
command's `{hidden:!0}` registration option to a marked `{hidden:/*twd-unhide*/!1}`,
which `--restore` flips back.

| Name | What it does | Needs |
|---|---|---|
| `statusline-probe` | Runs your `statusLine` command once under Droid's 5 s budget and prints JSON. | — |
| `rules` | `droid rules check [--file] [--command] [--json]` validates Execute-command permission rules, runs their self-tests, and previews the decision for one command. | — |
| `wiki-read`, `wiki-search`, `wiki-upload` | Read, search, or upload a repository's Factory wiki. | Factory login and wiki access |
| `software-factory` (`sf`) | ~80 subcommands for the Software Factory data model. | Software Factory for your org (403 otherwise) |
| `pull-request` | Lease, validate, submit, or release a pull-request layer manifest (used by Factory's PR reviewer sessions). | Factory backend, except `manifest-validate` |
| `record-triage-input` | Reports a triage automation run's consumed-message count to Software Factory. | Factory login, Software Factory for your org |
| `exec-script-options` | Adds `--tool-execution-mode` and `--[no-]allow-subagents-in-scripts` to `droid exec --help` (a hand-written help text). | a model on Factory's `script_tool_models` list for them to do anything |

Not offered: `push-git-ai-notes` and `git-ai-checkpoint-hook` are legacy
no-op hook targets, `session-index-refresh` is a maintenance process Droid
starts itself (and is registered in a form the unhide patch cannot match), and
`tui` is what plain `droid` already runs. `--append-system-prompt` and
`--append-system-prompt-file` are not hidden (both `droid` and `droid exec`
list them).

## Toggles reference

Notable flags in Droid 0.239.0, what forcing them does, and how tweakdroid
applies them. Every flag goes through the two flag patches above.

| Flag | ON does | Also needs | Notes |
|---|---|---|---|
| `alloy`, `alloy_byok` | Nothing: 0.239.0 no longer reads them (`auto` is always offered; native BYOK depends only on `modelPolicy.allowFactoryRouterByok`). | — | still in the flag catalog |
| `alloy_fast` | Adds `auto-fast` (Auto Model over `-fast` variants). | access to the `-fast` candidates | map the `-fast` labels too |
| `automations_v2` | Local `/automations` and the automation tools. | — | |
| `communication_prompt_v2` | Swaps prompt section 60 for 61 (Communication v2). | — | TUI, ACP, exec |
| `output_style_setting` | Appends the selected output style; Output style row in `/settings`. | `outputStyle` | TUI sessions only |
| `one_hour_anthropic_caching` | 1-hour cache TTL. | `enableOneHourAnthropicCaching` | in daemon sessions also a background cache-promotion request (an extra model call) |
| `mid_conversation_tool_changes` | Deferred tools load without breaking the prompt cache. | deferred tools, supported model | Anthropic BYOK customs excluded; GPT-5.4+ customs included |
| `cli_rules_engine` | Compiled rules engine for Execute allow/ask/block. | — | optional `permissionRules` setting |
| `droid_shield_2.0` | Factory-hosted risk classifiers on git commit/push; scans background git too. | `enableDroidShield`, Factory backend | without the backend the plain secret scan decides |
| `wiki` | Nothing: 0.239.0 always registers the wiki skills and `wiki-*` commands. | — | still in the flag catalog |
| `nested_task_delegation` | Concurrency limits for Task subagents. | — | dead as a feature in 0.239.0: nesting depth is clamped to 1 |

## Typical workflow

```bash
tweakdroid --extract
cp ~/.tweakdroid/system-prompts/02-main-interactive__always__openai-only.md ~/.tweakdroid/edited-prompts/
$EDITOR ~/.tweakdroid/edited-prompts
tweakdroid --apply --dry-run
tweakdroid --apply
```

Restart Droid or open a new Droid session after applying. Existing running Droid
processes are not hot-patched.

## Updating to a new Droid version

The repo ships a skill, `bump-droid-version`, that teaches the full loop:
update Droid, extract, read the warnings, fix drifted fingerprints, re-derive
router labels and flags, apply, and verify. It lives at
`.claude/skills/bump-droid-version/SKILL.md` (Claude Code) and is linked at
`.factory/skills/bump-droid-version` (Droid), so either agent picks it up when
you open this repo; or just read it.

## Notes

- Works on macOS Mach-O and Linux ELF Droid binaries. On Linux the codesign
  step is skipped.
- tweakdroid sees Droid's JavaScript modules as one text, the bundle: every
  module in table order, each after a `/*twd-chunk <name>*/` line. Patching
  never moves Droid's own bytes, because Bun's tables (source hashes, shared
  bytecode, the prelinked module graph) point into them by offset. A patched
  module's new text is appended after Bun's data with a record of what was
  replaced, and that module loses its precompiled bytecode so Bun runs the new
  text (only the few modules tweakdroid touches are parsed at startup).
  `--restore` drops the appended part and puts the recorded values back, which
  gives back the factory Bun data byte for byte. The Mach-O segment grows when
  the appended text does not fit its spare room; the file layout around the Bun
  data then differs from the factory file (`droid update` brings that back).
- Run `--extract` and `--apply` again after Droid updates (a Droid update
  replaces the binary and drops every patch). The
  [`bump-droid-version` skill](.claude/skills/bump-droid-version/SKILL.md)
  walks through the whole loop. Prompts are located by authored-prose fingerprints,
  so most version bumps need no code change. A prompt whose fingerprint is
  missing is skipped with a warning naming it; update its entry in `PROMPTS`
  in `src/index.mjs` if the prompt still exists under different wording.
- Each replaced prompt is tagged with a `/*twd:<id>:<factory text>*/` comment
  (the factory literal, base64-encoded), so it is found again even when your
  edit removed its fingerprint text, and `--restore` puts back the exact
  factory bytes from the binary alone.
- `--apply` always rebuilds from the restored factory bundle, so applying twice
  changes nothing, and the dry-run lists only what actually differs from the
  binary.
- `--apply` syntax-checks every patched module before writing, and checks that
  restoring it gives back the exact factory bundle; it leaves the binary
  untouched if either fails. Code patches (flags, remap, no-comments, provider
  router, unhide) have recognizable forms, so `--restore` removes every one of
  them from the binary alone, and every code pattern must match exactly once or
  the patch is refused.
- Use `--output` first if you want to test a patched copy before replacing your
  active Droid binary.

## Which prompt each mode uses

Droid builds the system message from two blocks plus conditional extras:

1. `01-core-identity` (one line, shared by every mode).
2. The mode prompt:
   - TUI and ACP (`droid exec --output-format acp` / `acp-daemon`):
     `02-main-interactive`. ACP sessions pass no prompt override, so they use
     the same prompt as the TUI (Droid only disables the AskUser tool there).
   - `droid exec` (text, json, stream-json, stream-jsonrpc exec sessions):
     `03-exec-noninteractive`.
   - `droid exec --mission`: `04-mission-noninteractive` plus the mission
     orchestrator skill (`51`). Interactive mission orchestrators use `02` plus
     `51`; mission workers use `03` plus `54`.
3. Extras: `64` when TodoWrite is available, `65` for registry models flagged
   batchTodoWrite, `66` for service accounts, `12` (no-comments), Gemini-only
   `08`-`10`, and the output style (`70` for the concise style).

`02` and `03` are templates: their `{{1}}`, `{{2}}`, `{{3}}` are the harness
(`58`, which itself includes `62` or, in airgap mode, `63`), "Working in
repositories" (`59`), and Communication (`60`) sections. With the
`communication_prompt_v2` flag, Droid swaps the text of `60` for `61`. Edit a
section file to change it everywhere, or drop the placeholder from `02`/`03`.

## Per-provider prompts

`01` and `02` also come in `anthropic-only`, `openai-only`, and `google-only`
variants. `--apply` adds a small router to Droid's system-message builder that
picks the variant matching the provider of the model being called (BYOK custom
models count by their configured provider; anything that is not `openai` or
`google` uses the Anthropic file). A provider without its own edited file falls
back to the edited all-providers file, then to the factory text. The variants
apply wherever Droid builds the standard system message (TUI, ACP, exec,
missions), but the `02` variants only replace the default interactive prompt:
any session that supplies its own prompt gets the `01` variant and that prompt
instead. That covers exec and mission sessions, interactive mission
orchestrators (`02` plus `51`, using the all-providers `02`), and sessions
started with `--append-system-prompt` (Droid then passes the base `02` with
your text appended).

## no_comments for every model

Droid appends the no-comments block (`12`) only for registry models whose
`systemPromptReminders` include `no-comments`: the Anthropic frontier models.
Droid 0.211 maps BYOK customs onto their registry model by name, so a custom
`claude-opus-4-8` already gets it, but GPT customs and customs with unknown
model names do not. `--apply` widens the gate so every model gets the block;
`--restore` narrows it back.

## Injected runtime prompts

Droid does not only send a static system prompt; as a session runs it injects
text into the conversation: `<system-reminder>` and `<system-notification>`
blocks, the startup environment block, mission prompts, and slash-command
payloads. tweakdroid extracts these too, as files `13` and up in
`system-prompts/`, along with side-model prompts such as the Auto Model
classifier (`73`) and the command-risk classifier (`74`).

Many prompts carry runtime values (`${...}`); tweakdroid surfaces each as a
`{{1}}`, `{{2}}`, … placeholder and records what it is on the
`interpolations:` frontmatter line. To edit one, copy it into `edited-prompts/`
and change the prose, leaving the `{{N}}` placeholders where the runtime values
should land; `--apply` substitutes the live expressions back in. Placeholders
can be moved, dropped, or duplicated; what they resolve to cannot be changed.
Moving, dropping, or duplicating placeholders is safe to undo: `--restore` and
deleting the edited file both put back the factory literal stored in the
binary's patch marker.
