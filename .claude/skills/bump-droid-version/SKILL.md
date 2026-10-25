---
name: bump-droid-version
description: Update tweakdroid for a new Factory Droid release - update Droid, extract, fix drifted fingerprints, router labels and flags, re-apply, and verify the patched binary.
---

# Bump tweakdroid to a new Droid version

A Droid update replaces the binary and drops every tweakdroid patch. Most
releases only need `--extract` and `--apply`; some move prompts, router labels,
flags, or the code tweakdroid patches. Work through the steps in order and stop
at the first one that fails.

Run commands from the tweakdroid repo. If `tweakdroid` is not linked globally,
use `node src/index.mjs` instead. Add `--binary /path/to/droid` when `droid` on
PATH is not the binary you mean.

## Ground rules

- Never send a prompt to a model while checking a build unless the user asked
  for a live smoke test. Everything below up to "Optional live smoke tests"
  costs no model tokens.
- Search the binary with `grep -a` or with node. Plain BSD `grep` gives false
  negatives on it. Prefer working on the dumped bundle (step 4).
- Fingerprints and code anchors are authored prose and string literals, never
  minified identifiers. Identifiers like `eh`, `HY`, `joR` change between
  builds, and macOS and Linux builds minify differently.
- Every code pattern tweakdroid patches must match exactly once, and every
  patch must be removable by `--restore` from the binary alone. Keep both
  properties when you change a pattern.
- Do not make backup copies of the binary. To experiment, copy it to a temp
  directory, use `--binary` or `--output`, and delete the copy afterwards.

## 1. Update Droid

```bash
droid update
droid --version
```

If the binary was patched by an old tweakdroid that cannot restore it (the
error says the markers cannot be undone in place), `droid update` or a
reinstall gives you a clean binary.

## 2. Extract and read every warning

```bash
tweakdroid --extract
tweakdroid --apply --dry-run
```

Warnings and what they mean:

- `known prompt(s) were not found in this build and were skipped` - a
  fingerprint drifted or the prompt was removed. Go to step 3.
- `fingerprint ... is not unique` or `no string literal encloses fingerprint` -
  the fingerprint now matches twice, or sits too far into its literal. Go to
  step 3. One bad fingerprint aborts the whole extract.
- `edited prompt(s) match no prompt in this Droid build` - an override in
  `~/.tweakdroid/edited-prompts` targets a prompt Droid removed. Delete it or
  move its content to the prompt that replaced it.
- `the factory text behind N edited prompt(s) changed` - Droid rewrote a prompt
  you override. Diff `system-prompts/<file>` against your edit and carry over
  the upstream changes you want.
- `neither router-byok-map.json nor native BYOK covers these Auto Model labels` -
  router labels changed. Go to step 5.
- `feature-flags.json names flags this Droid build does not have` - a flag was
  renamed or removed. Go to step 6.
- `... not found in this droid version; skipped` (provider router, no-comments
  gate, custom-model resolver, feature-flag resolver, snapshot override merger)
  or `cannot unhide ...` - Droid changed code that a patch anchors on. Go to
  step 7.
- `system-prompts were extracted from Droid X, but the binary is Droid Y` - run
  `--extract` again.

## 3. Find a new fingerprint for a drifted prompt

Prompts live in the `PROMPTS` table in `src/index.mjs`. Each has a
`fingerprint`: authored prose that occurs exactly once in the bundle and sits
near the start of its string literal.

1. Dump the factory bundle (tweakdroid restores it in memory first):

   ```bash
   tweakdroid --dump-source /tmp/droid.js
   ```

2. Find where the prompt went. Search for a distinctive phrase from the old
   text in `~/.tweakdroid/system-prompts/<file>` (from before the update) or
   from git history:

   ```bash
   node -e 'const s=require("fs").readFileSync("/tmp/droid.js","utf8");const q=process.argv[1];let i=-1,n=0;while((i=s.indexOf(q,i+1))!==-1){n++;console.log(i,JSON.stringify(s.slice(i-200,i+200)))}console.log("hits:",n)' 'a distinctive phrase'
   ```

3. Pick new fingerprint text:
   - Authored prose, never an identifier or a `${...}` expression.
   - Exactly one hit in the bundle.
   - Close to the start of the literal, with no quote character between the
     literal's opening quote and the fingerprint.
   - The fingerprint must appear both in the source text and in the decoded
     literal, so in a `"..."` literal pick prose without a newline. Template
     literals contain real newlines, which a fingerprint may include.
   - The same prose can now sit in several modules (Droid duplicates small
     helpers and keeps variant prompts side by side); pick text only the
     target literal has.
4. Update the entry, then run `--extract` again. Extract checks that every
   prompt round-trips through the patcher and that no two prompts overlap.
5. If a prompt was removed upstream, delete its `PROMPTS` entry, any matching
   file in `prompts/edited-prompts/`, and its README mentions.

## 4. Inspect the bundle

`/tmp/droid.js` from step 3 is the factory bundle: every JavaScript module of
the binary in table order, each after a `/*twd-chunk /$bunfs/root/<name>*/`
line. Minified names are unique only within one module, so follow an
identifier inside its module (or through that module's `import{...}from`), and
look up functions with `functionBody(source, name, at)`, which searches only the
module containing position `at`. Useful anchors (string literals, which
survive minification):

- Flag catalog entries look like `Name:{displayName:"...",statsigName:"...",defaultValue:!1}`.
- The flag resolver destructures `{statsigName:...,defaultValue:...}` from its
  first parameter.
- The env-override merger calls the env-override reader and copies its result
  into the snapshot object it is given
  (`let a=T();if(!a)return;for(let[o,l]of Object.entries(a))t[o]=l`). In
  production 0.239 builds the reader is compiled to `return null`, so
  `FACTORY_FEATURE_FLAGS_OVERRIDES` has no effect there.
- The system-message builder is exported as `buildSystemMessageBlocks:<name>`.
- Router candidates sit next to `Router candidate reasoningEffort is not in the registry supported set`.
- Hidden subcommands are registered with `addCommand(<factory>(),{hidden:!0})`,
  and each factory starts with `new <Command>("<name>")`.
- `droid exec --help` text starts with `Usage: droid exec [options] [prompt]`.

## 5. Re-derive router labels

```bash
tweakdroid --list-router-labels
```

It prints `candidates`, `classifiers` (in the order Droid tries them), and
`fastCandidates` (the `-fast` variants Auto Model Fast uses). If it prints
`null`, the anchors in `routerLabels()` in `src/index.mjs` drifted; fix them
from the bundle.

Then cover every label with your own custom model, in one of two ways:

- Remap: edit `~/.tweakdroid/router-byok-map.json` or use the TUI Model Router
  view. Keep keys for labels older versions emit; they are harmless.
- Native BYOK: `tweakdroid --native-byok` shows the status, and
  `tweakdroid --native-byok-assign LABEL=custom:ID` assigns a label.

List your custom model ids with `droid exec -m __probe__ --list-tools`. The
model id is invalid on purpose: Droid prints the available models and exits
without calling a model. Update `DEFAULT_ROUTER_LABELS` in `src/tui/helpers.mjs`
and the label list in the README.

## 6. Re-derive flags, hidden commands, and settings

```bash
tweakdroid --list-flags     # every flag: default, cached server value, forced value
tweakdroid --list-hidden    # hidden commands tweakdroid can show, and whether each is patchable
tweakdroid --list-settings  # settings.json toggles
```

- For a renamed flag, update `~/.tweakdroid/feature-flags.json` with
  `tweakdroid --flag NEW=on --flag OLD=default`, and update `FLAG_NOTES` in
  `src/catalog.mjs`.
- For each flag in `FLAG_NOTES`, re-check in the bundle what it gates. Find its
  catalog key (`Key:{displayName:...,statsigName:"name"...}`), then every
  `.Key` reference, and read the code around each one. Note any settings key it
  also needs (add it to `SETTINGS` in `src/catalog.mjs`) and whether it still
  does anything.
- For hidden commands, compare the top-level `addCommand(...,{hidden:!0})`
  calls with `HIDDEN_COMMANDS` in `src/catalog.mjs`.
- For settings, check the settings schema (search for a key such as
  `toolExecutionMode:`) for renamed keys or enum values.
- Some features moved from flags to server-side Statsig dynamic configs, which
  no local flag can force (0.239: `script_tool_models` decides which models may
  run `script_only`; `execute_risk_classifier_shadow` replaced the risk
  classifier flag). Re-check that list too, and mark flags nothing reads any more
  (find the catalog key, then count `.Key` references) as having no effect.

## 7. Repair a code patch

When a code patch reports "not found" or "ambiguous", find the new shape in the
bundle and update the regex in `src/index.mjs`:

- feature flags: `FLAG_RESOLVER_*` and `FLAG_SNAPSHOT_*`
- remap: `applyRouterByokRemap`
- no-comments: `NO_COMMENTS_*`
- provider router: `systemMessageBuilder` and `analyzeRouterTargets`
- unhide: `hiddenCommandSite` and `EXEC_HELP_ANCHOR`

Anchor on string literals and structure, capture identifiers instead of
hard-coding them, and make sure each pattern matches exactly once in the bundle
(`codeMatches` throws otherwise). Each patch must have a patched form that
`restoreSource` recognizes and turns back into the exact factory text.
`--apply` refuses to write a bundle that does not parse or that does not
restore to the factory bundle.

## 8. Apply and verify

Test on a copy first:

```bash
tweakdroid --dump-source /tmp/droid.js                    # factory bundle, if step 3 did not make it
cp "$(command -v droid)" /tmp/droid-test
tweakdroid --apply --binary /tmp/droid-test
tweakdroid --apply --dry-run --binary /tmp/droid-test     # must print: Dry run: no changes.
tweakdroid --binary /tmp/droid-test                       # TUI: walk through every view (Apply there patches the copy)
tweakdroid --restore --binary /tmp/droid-test
tweakdroid --dump-source /tmp/restored.js --binary /tmp/droid-test
cmp /tmp/restored.js /tmp/droid.js                        # restore is byte-identical
rm /tmp/restored.js                                       # keep /tmp/droid-test for the probe below
```

The TUI's Droid Settings and Native Auto BYOK views write
`~/.factory/settings.json` directly. To try them without touching your real
settings, run the TUI with `FACTORY_HOME_OVERRIDE=/tmp/fh` and a copy of the file
at `/tmp/fh/.factory/settings.json`.

Then apply to the real binary and check both inverse dry-runs:

```bash
tweakdroid --apply
tweakdroid --apply --dry-run      # Dry run: no changes.
tweakdroid --restore --dry-run    # Dry run: source would change.
droid --version                   # the new version
codesign -v "$(command -v droid)" # macOS only; silent on success
```

Probe that the patched modules run, still without calling a model. Droid's own
`FACTORY_FEATURE_FLAGS_OVERRIDES` is inert in production builds (step 4), so
compare a forced flag on the test copy with the factory binary instead. On the
copy from the step above, with a scratch config folder:

```bash
cp -R ~/.tweakdroid /tmp/twd-test
tweakdroid --dir /tmp/twd-test --flag alloy_fast=on --unhide rules=on --binary /tmp/droid-test
tweakdroid --dir /tmp/twd-test --apply --binary /tmp/droid-test
/tmp/droid-test exec -m __probe__ --list-tools | grep -m1 -o '^  auto, auto-fast,'   # present only on the patched copy
/tmp/droid-test --help | grep '^  rules'                                         # unhidden command is listed
rm -rf /tmp/twd-test /tmp/droid-test
```

A patched module that still behaves like the factory one means Bun ran its
precompiled bytecode: check that `patchedBunData` cleared that module's
bytecode pointer and source hash.

Restart running Droid sessions: they keep the old code in memory.

## 9. Optional live smoke tests (only when the user asks)

These send real requests:

- `droid exec -m custom:<id> "Reply with OK"` checks a BYOK model end to end.
- `droid exec -m auto "Reply with OK"` checks Auto Model. Then read the routing
  decision in `~/.factory/logs/droid-log-single.log`:

  ```bash
  grep -a '\[Model-Router\] Routed' ~/.factory/logs/droid-log-single.log | tail -3
  ```

  `modelId` is the chosen label and `source` is the classifier label. For a
  native BYOK classifier, `source` is `<label>:byok`. `source: "fallback"`
  means the classifier failed and Droid used its fallback model, which usually
  points at an auth or proxy problem upstream, not at tweakdroid.

## BYOK through a Claude-subscription proxy

If your Anthropic custom models go through a local proxy that uses a Claude
subscription, the proxy must forward Droid's system prompt. Otherwise Claude
never sees your prompt edits, although GPT requests still do. In CLIProxyAPI
that setting is `cloak-forward-system-prompt: true`. To check what reaches the
model, turn on the proxy's request log and look at the system field of one
request; do not ask the model to describe its own prompt.

## Recovery

- `tweakdroid --restore` puts back the factory bundle using only what the
  patched binary carries (each replaced prompt stores its factory text in a
  `/*twd:<id>:<base64>*/` marker, and code patches have recognizable forms).
- If restore refuses (binaries patched by a much older tweakdroid), run
  `droid update` or reinstall Droid.
- Settings tweakdroid wrote to `~/.factory/settings.json` are not part of the
  binary. Undo them with `tweakdroid --setting KEY=unset` and
  `tweakdroid --native-byok-unassign LABEL` (which needs no binary).

## Finish

- Update the supported version and label lists in `README.md`, and the facts in
  `src/catalog.mjs`.
- Run `pnpm check` (`node --check` on every source file).
- Run `pnpm test:compat` (or `pnpm test:compat --binary /path/to/droid`). It
  exercises all prompt edits and code patches on a temporary binary with isolated
  settings, checks runtime flag ON/OFF behavior without model calls, and verifies
  idempotence and exact factory-source restoration. It also checks that the TUI
  fallback router labels match the release being verified.
- Commit and push without asking: once `pnpm check` and `pnpm test:compat`
  pass and `--apply` succeeded on the real binary, commit everything on `main`
  as `Support Droid X.Y.Z` (one commit per version, with a short body listing
  what drifted), then `git pull --rebase` and `git push`. Do not push if any
  check failed; report the failure instead.
