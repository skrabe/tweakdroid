# Mac retesting

Linux ELF support landed alongside the existing Mach-O path. The patcher now
auto-detects the platform and derives Bun-bundle symbol names by content
fingerprint rather than hardcoding them — the previous `pp` / `RUH` / `zsT`
table is gone, and `--extract` should work on any Droid 0.116.x build that
matches the structural anchors below.

Please retest on macOS to confirm the Mach-O path still works.

## Steps

```bash
cd ~/dev/tweakdroid
git pull
npm install   # or pnpm install
node src/index.mjs --extract
node src/index.mjs --apply --dry-run
node src/index.mjs --apply
```

## Expected output

`--extract`:

```
Extracted 18 prompts to /Users/<you>/.tweakdroid/system-prompts
Editable prompts are in /Users/<you>/.tweakdroid/edited-prompts
```

The generated `~/.tweakdroid/system-prompts/manifest.json` should include an
`orchestratorFn` field. On macOS 0.116.1 it will be `zsT`; on the Linux build
it was `xs$`.

`--apply --dry-run` should print one `... -> ...` line per prompt followed by
`(binary patch: warmup enabled for BYOK): 35 -> 35`.

`--apply` should:

- Write a `droid.tweakdroid-backup-<timestamp>` next to the binary.
- Print `Applied prompt changes to /Users/<you>/...`.
- Re-codesign the resulting binary (the codesign step is Mac-only and is
  skipped on Linux).

After applying, `droid --version` should still return `0.116.1`.

## What to watch for

- If `--extract` fails with `deriveSymbols: could not locate <id> via
  fingerprint`, the Mac bundle has a prompt whose distinctive opener differs
  from what the Linux 0.116.1 build had. Drop me the failing id + a snippet of
  the surrounding source so I can broaden the fingerprint.
- If `--apply` fails with `Could not find function <name> base prompt
  initialization`, the orchestrator's `let X=[{type:"text",text:CORE},
  {type:"text",text:A??MAIN}]` pattern shifted. Same — share the surrounding
  source.
- If `codesign` complains, that's the same as before the ELF work; the
  codesign step is unchanged.
