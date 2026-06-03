# tweakdroid

Extract, edit, restore, and re-apply Factory Droid system prompts.

`tweakdroid` patches the prompt text embedded in the local Droid binary. It is
for people who want real prompt replacement instead of append-only overrides.

## What it does

- Extracts Droid prompt blocks into Markdown files.
- Extracts the runtime-injected reminders, notifications, and squad/mission prompts too.
- Keeps extracted defaults separate from edited prompts.
- Lets Anthropic, OpenAI, and Google use different `01` and `02` prompts.
- Applies edits back into the Droid binary.
- Restores the binary back to extracted defaults without deleting edits.
- Supports dry-runs; patches the Droid binary in place.
- Routes Factory Router (Auto Model) through your own BYOK custom models.
- Forces Statsig feature flags (Auto Model, `/loop`, …) on or off without env vars.
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

- **Model Router** — map each Factory Router tier to one of your `~/.factory`
  custom models (see below). Flags malformed (dotted-name) models.
- **Feature Flags** — toggle any of Droid's ~66 Statsig flags.
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

`--extract` refreshes `system-prompts` and creates `edited-prompts` if needed,
but it never creates, edits, or deletes prompt files inside `edited-prompts`.

## Included prompts

This repository includes my current edited prompts in:

```text
prompts/edited-prompts
```

These prompts are specialized for **GPT-5.5** and **Claude Opus 4.7**. They
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

## Factory Router on your BYOK models

Factory Router ("Auto Model") classifies each task and routes it to a tier of
Factory-hosted models — which 402s if your account has no Factory subscription.
tweakdroid reroutes the router's own calls (its classifier and the model it
picks) to your `~/.factory` BYOK custom models, so Auto Model runs on your subs.

It works by remapping the router's resolved model ids at `QL` (Droid's
custom-model resolver). The mapping lives in `~/.tweakdroid/router-byok-map.json`
— Factory's tier label → one of your `custom:` ids:

```json
{
  "claude-opus-4-7": "custom:CC:-Opus-4.8-(Max)-36",
  "kimi-k2.6":       "custom:GPT-5.5-(High)-41",
  "minimax-m2.7":    "custom:GPT-5.3-Codex-Spark-43",
  "gpt-5.4-mini":    "custom:CC:-Sonnet-4.6-(Auto)-3"
}
```

Edit it directly or use the **Model Router** view, then `--apply`. An empty/
absent file leaves the router untouched. (Pair it with the `alloy` feature flag
below so Auto Model actually shows up.)

## Feature flags

Droid gates preview features behind Statsig flags (`alloy` = Auto Model,
`loop_command` = `/loop`, `squad`, …). `~/.tweakdroid/feature-flags.json` maps
`statsigName → true|false`:

```json
{ "alloy": true, "loop_command": true }
```

`--apply` forces these by injecting an override at the top of the flag resolver
`X1`, so they win over the server value (flipping the flag's `defaultValue` is
not enough — Droid reads the server first). Toggle any flag in the **Feature
Flags** view, or run `--list-flags` to see them all. `--restore` removes the
overrides.

Forcing a flag only makes the *client* treat the feature as enabled. Purely
local features (`/loop`) then work; server-backed ones (Auto Model routing,
`squad`) may still need entitlement or, like Auto Model, extra client work.

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
- Run `--extract` again after Droid updates. Symbol names are auto-derived by
  content fingerprint each run, so most version bumps should not require code
  changes; if `--extract` errors with `deriveSymbols: could not locate ...`,
  the bundle structure has shifted and `PROMPT_FINGERPRINTS` in
  `src/index.mjs` needs the updated marker.
- Use `--output` first if you want to test a patched copy before replacing your
  active Droid binary.

## Orchestrator/worker prompts

The base `dv` (core identity) and `eGH` (main interactive) variables are also
referenced directly by orchestrator and worker code paths, not just the routed
`qsT` function. tweakdroid extracts and patches them via two extra prompt
files: `01-core-identity__always__all-providers.md` and
`02-main-interactive__always__all-providers.md`. Edit those if you want your
changes to apply to orchestrator/worker too — otherwise leave them as the
extracted factory defaults.

## no_comments for custom models

Droid appends the `no_comments` prompt block only for built-in models with
`systemPromptAdditions:{noComments:!0}` in the registry (today only
claude-opus-4-7). BYOK / custom models always skip it because they have
no registry entry. `--apply` flips the orchestrator gate from
`if(B?.systemPromptAdditions?.noComments)` to
`if(B?.systemPromptAdditions?.noComments||!B)` so custom models also get the
block. `--restore` flips it back.

## Injected runtime prompts

Droid does not only send a static system prompt — as a session runs it injects
text into the conversation: `<system-reminder>` and `<system-notification>`
blocks, the startup environment block, squad/mission system prompts, and
slash-command payloads. tweakdroid extracts these too, as files `13` and up in
`system-prompts/`.

They are located by a content fingerprint instead of a symbol, so most Droid
updates need no code change. Many carry runtime values (`${...}`); tweakdroid
surfaces each as a `{{1}}`, `{{2}}`, … placeholder and records what it is on the
`interpolations:` frontmatter line. To edit one, copy it into `edited-prompts/`
and change the prose, leaving the `{{N}}` placeholders where the runtime values
should land — `--apply` substitutes the live expressions back in. Placeholders
can be moved, dropped, or duplicated; what they resolve to cannot be changed.
