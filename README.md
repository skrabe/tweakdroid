# tweakdroid

Extract, edit, restore, and re-apply Factory Droid system prompts.

`tweakdroid` patches the prompt text embedded in the local Droid binary. It is
for people who want real prompt replacement instead of append-only overrides.

## What it does

- Extracts Droid prompt blocks into Markdown files.
- Keeps extracted defaults separate from edited prompts.
- Lets Anthropic, OpenAI, and Google use different `01` and `02` prompts.
- Applies edits back into the Droid binary.
- Restores the binary back to extracted defaults without deleting edits.
- Supports dry-runs and writes a timestamped backup before in-place patching.

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

- This is intended for local Factory Droid installs on macOS Mach-O binaries.
- Run `--extract` again after Droid updates. The Bun-bundle symbol names are
  obfuscated and change between releases; if `--extract` errors, update the
  `PROMPTS` table in `src/index.mjs` with the new names (search the binary
  for distinctive prompt strings to find them).
- Use `--output` first if you want to test a patched copy before replacing your
  active Droid binary.

## Warmup gate

`--apply` also enables cache warmup for BYOK (custom-provider) models by
flipping the `if(...isCustom)return!1;return!0` gate to `return!0;return!0`.
`--restore` flips it back to the factory default. This used to live in a
separate `patch-droid-warmup.sh` script.

## Orchestrator/worker prompts

The base `dv` (core identity) and `eGH` (main interactive) variables are also
referenced directly by orchestrator and worker code paths, not just the routed
`qsT` function. tweakdroid extracts and patches them via two extra prompt
files: `01-core-identity__always__all-providers.md` and
`02-main-interactive__always__all-providers.md`. Edit those if you want your
changes to apply to orchestrator/worker too — otherwise leave them as the
extracted factory defaults.
