# tweakdroid

Extract, edit, restore, and re-apply Factory Droid system prompts.

`tweakdroid` patches the prompt text embedded in the local Droid binary. It is
for people who want real prompt replacement instead of append-only overrides.

Supported Droid version: **0.211.0** (macOS Mach-O and Linux ELF). Droid 0.211
rebuilt its system prompt from sections, so this release does not patch Droid
0.153 or older; use an older tweakdroid commit for those.

## What it does

- Extracts Droid prompt blocks into Markdown files.
- Extracts the runtime-injected reminders and notifications, mission prompts, and
  side-model prompts (Auto Model classifier, risk classifier) too.
- Keeps extracted defaults separate from edited prompts.
- Lets Anthropic, OpenAI, and Google use different `01` and `02` prompts.
- Applies edits back into the Droid binary.
- Restores the binary back to extracted defaults without deleting edits.
- Supports dry-runs; patches the Droid binary in place.
- Routes Factory Router (Auto Model) through your own BYOK custom models.
- Forces Statsig feature flags (Auto Model, automations, …) on or off without env vars.
- Ships an interactive terminal UI for all of the above.

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
terminal UI built with Ink. No build step — it runs straight from source.

```bash
tweakdroid          # launches the TUI
```

Four views, driven with the arrow keys:

- **Model Router** — map each Auto Model label (read from the installed binary)
  and the classifier to one of your `~/.factory` custom models (see below).
  Flags malformed (dotted-name) models.
- **Feature Flags** — toggle any of Droid's ~120 Statsig flags.
- **System Prompts** — open prompt overrides in your editor; revert to factory.
- **Apply / Status** — dry-run, apply, restore, or re-extract.

The first three views only write config files (`router-byok-map.json`,
`feature-flags.json`, `edited-prompts/`); nothing touches the binary until you
run **Apply** (which is just `tweakdroid --apply`).

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

These prompts are specialized for **GPT-5.5** and **Claude Opus 4.8**. They
should not be used with other AI models unless you review and retune them first.
Files `05`-`07` and `11` target prompts Droid 0.211 removed and are ignored.

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

Restore the binary to `system-prompts` without touching `edited-prompts`:

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

List the binary's Statsig feature flags as JSON:

```bash
tweakdroid --list-flags
```

List the model labels Auto Model can emit (its candidates and the ordered
classifier list) as JSON:

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
one of your `custom:` ids. Droid 0.211.0 emits these labels:

- candidates: `claude-opus-5`, `kimi-k3`, `kimi-k2.7-code`, `minimax-m3`,
  `deepseek-v4-flash-0731`, `glm-5.2`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`
- classifier: the first id the account may use from `gpt-5.4-mini-fast`,
  `gpt-5.4-mini`, `claude-haiku-4-5-20251001`, `glm-5.2-fast`, …

```json
{
  "claude-opus-5": "custom:CC:-Opus-4.8-(Max)-36",
  "gpt-5.6-sol": "custom:GPT-5.5-(High)-41",
  "kimi-k3": "custom:GPT-5.5-(High)-41",
  "glm-5.2": "custom:GPT-5.5-(High)-41",
  "gpt-5.6-terra": "custom:GPT-5.5-(High)-41",
  "kimi-k2.7-code": "custom:GPT-5.5-(High)-41",
  "deepseek-v4-flash-0731": "custom:GPT-5.3-Codex-Spark-43",
  "gpt-5.6-luna": "custom:GPT-5.3-Codex-Spark-43",
  "minimax-m3": "custom:GPT-5.3-Codex-Spark-43",
  "gpt-5.4-mini-fast": "custom:GPT-5.4-Mini-84",
  "gpt-5.4-mini": "custom:GPT-5.4-Mini-84"
}
```

Labels change between Droid versions, and an unmapped label silently falls
through to Factory's billed endpoint. `--apply` therefore reads the labels from
the binary and warns about any candidate or classifier it would leave unmapped;
`tweakdroid --list-router-labels` prints them. Keys for labels a version no
longer emits are harmless, so keep old keys if you switch between versions.
Factory can also replace the candidate list at runtime (the
`factory_router_candidates` dynamic config), which no static check can see.

Every value must be a `custom:` id exactly as Droid reports it (run
`droid exec -m x --list-tools` to list them). Edit the file directly or use the
**Model Router** view, then `--apply`. An empty/absent file leaves the router
untouched. Pair it with the `alloy` feature flag below so Auto Model shows up.

## Feature flags

Droid gates preview features behind Statsig flags (`alloy` = Auto Model,
`automations_v2` = local `/automations`, `script_tools` = the Script tool, …).
`~/.tweakdroid/feature-flags.json` maps `statsigName → true|false`:

```json
{ "alloy": true, "automations_v2": true }
```

`--apply` forces these by injecting an override at the top of Droid's flag
resolver, so they win for every check that goes through that resolver, over
the server value and Droid's own `FACTORY_FEATURE_FLAGS_OVERRIDES` environment
variable (flipping the flag's `defaultValue` is not enough, because Droid reads
the server first). A few code paths read the server's flag snapshot directly
instead of asking the resolver; those still see the server value. Toggle any
flag in the **Feature Flags** view, or run `--list-flags` to see them all;
`--apply` warns about names the binary does not have. `--restore` removes the
overrides.

Forcing a flag only makes the *client* treat the feature as enabled. Purely
local features then work; server-backed ones may still need entitlement or
extra client work.

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

## Notes

- Works on macOS Mach-O and Linux ELF Droid binaries. On Linux the codesign
  step is skipped.
- Run `--extract` again after Droid updates (a Droid update replaces the binary
  and drops every patch). Prompts are located by authored-prose fingerprints,
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
- `--apply` syntax-checks the patched bundle before writing and leaves the
  binary untouched if it would not parse.
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
