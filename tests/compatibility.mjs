import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HIDDEN_COMMANDS, FLAG_NOTES, SETTINGS } from '../src/catalog.mjs';

const engine = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const input = process.argv.slice(2);
assert.ok(input.length === 0 || (input.length === 2 && input[0] === '--binary'),
  'Usage: pnpm test:compat [--binary /path/to/droid]');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakdroid-compat-'));
const binary = path.join(root, 'droid');
const config = path.join(root, 'config');
const env = { ...process.env, FACTORY_HOME_OVERRIDE: root };

function run(command, args, expectedStatus = 0) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, expectedStatus, `${command} ${args.join(' ')}\n${output}`);
  return output;
}

function cli(...args) {
  const output = run(process.execPath, [engine, '--binary', binary, '--dir', config, ...args]);
  assert.doesNotMatch(output, /Warning:|skipped|codesign failed/, output);
  return output;
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(config, name), JSON.stringify(value));
}

try {
  const original = input[1] ? path.resolve(input[1]) : run('which', ['droid']).trim();
  fs.copyFileSync(original, binary);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'settings.json'), '{}');
  const version = run(binary, ['--version']).trim();
  console.log(`Checking Droid ${version} on a temporary copy.`);
  cli('--dump-source', path.join(root, 'factory.js'));
  const factory = fs.readFileSync(path.join(root, 'factory.js'));
  cli('--extract');
  const manifest = JSON.parse(fs.readFileSync(path.join(config, 'system-prompts', 'manifest.json')));
  assert.equal(manifest.droidVersion, version);
  assert.deepEqual(manifest.missing, []);
  assert.ok(manifest.prompts.length > 0);

  const labels = JSON.parse(cli('--list-router-labels'));
  for (const key of ['candidates', 'classifiers', 'fastCandidates']) {
    assert.ok(Array.isArray(labels[key]) && labels[key].length > 0, `Missing router ${key}`);
  }
  const { readRouterLabels } = await import('../src/tui/helpers.mjs');
  assert.deepEqual(await readRouterLabels(null), {
    ...labels,
    classifierKeys: labels.classifiers.slice(0, labels.classifiers.findIndex(id => labels.candidates.includes(id))),
  }, 'TUI fallback labels must match the supported Droid release');
  const flags = JSON.parse(cli('--list-flags'));
  for (const flag of Object.keys(FLAG_NOTES)) {
    assert.ok(flags.some(entry => entry.statsigName === flag), `Unknown documented flag: ${flag}`);
  }
  const hidden = JSON.parse(cli('--list-hidden'));
  assert.equal(hidden.length, HIDDEN_COMMANDS.length);
  assert.ok(hidden.every(entry => entry.available && !entry.problem));
  const settings = JSON.parse(cli('--list-settings'));
  assert.deepEqual(settings.settings.map(entry => entry.key), SETTINGS.map(entry => entry.key));

  for (const prompt of manifest.prompts) {
    const content = fs.readFileSync(path.join(config, 'system-prompts', prompt.file), 'utf8');
    fs.writeFileSync(path.join(config, 'edited-prompts', prompt.file), `${content}\nCompatibility check: ${prompt.id}.\n`);
  }
  writeJson('router-byok-map.json', Object.fromEntries(
    [...labels.candidates, ...labels.classifiers, ...labels.fastCandidates].map(id => [id, 'custom:tweakdroid-compatibility-probe'])
  ));
  writeJson('feature-flags.json', { alloy_fast: true, communication_prompt_v2: false });
  writeJson('unhide.json', Object.fromEntries(HIDDEN_COMMANDS.map(entry => [entry.name, true])));
  const dryRun = cli('--apply', '--dry-run');
  for (const feature of ['provider router for 01/02', 'no-comments block for every model', 'Auto Model remap', 'feature flags forced', 'hidden commands shown', 'Script-tool options']) {
    assert.ok(dryRun.includes(feature), `Patch was not exercised: ${feature}`);
  }
  cli('--apply');
  assert.equal(cli('--apply', '--dry-run').trim(), 'Dry run: no changes.');
  assert.equal(run(binary, ['--version']).trim(), version);
  if (process.platform === 'darwin') run('codesign', ['-v', binary]);
  const help = run(binary, ['--help']);
  for (const entry of HIDDEN_COMMANDS.filter(entry => entry.kind === 'command')) {
    assert.match(help, new RegExp(`^\\s+${entry.name}\\b`, 'm'));
  }
  assert.ok(run(binary, ['exec', '--help']).includes('--tool-execution-mode'));
  const probe = () => run(binary, ['exec', '-m', '__tweakdroid_compatibility_probe__', '--list-tools'], 1);
  assert.match(probe(), /^\s+auto, auto-fast,/m);
  writeJson('feature-flags.json', { alloy_fast: false, communication_prompt_v2: false });
  cli('--apply');
  assert.doesNotMatch(probe(), /^\s+auto, auto-fast,/m);
  cli('--extract');
  const reextracted = JSON.parse(fs.readFileSync(path.join(config, 'system-prompts', 'manifest.json')));
  assert.deepEqual(reextracted.prompts, manifest.prompts);
  cli('--restore');
  assert.equal(cli('--restore', '--dry-run').trim(), 'Dry run: no changes.');
  cli('--dump-source', path.join(root, 'restored.js'));
  assert.ok(fs.readFileSync(path.join(root, 'restored.js')).equals(factory), 'Restore must reproduce the exact factory bundle');
  assert.equal(run(binary, ['--version']).trim(), version);
  console.log(`Passed: ${manifest.prompts.length} prompts, ${flags.length} flags, router remapping, provider prompts, hidden commands, runtime flag ON/OFF, idempotence, and exact source restoration.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
