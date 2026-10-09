import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { html, theme, readFlagsOverrides, readCachedServerFlags, readFlagCatalog } from '../helpers.mjs';
import { SETTINGS } from '../../catalog.mjs';
import { readFactorySettings, updateFactorySettings, factorySettingsPath, getPath } from '../../factory-settings.mjs';

const show = (v) => (v === undefined ? 'unset' : JSON.stringify(v));

// Droid settings that are plain ~/.factory/settings.json keys. Each change is
// written immediately (only that key changes; the rest of the file is kept).
export function SettingsView({ binary, onBack }) {
  const load = () => {
    try {
      const { data } = readFactorySettings();
      return { values: SETTINGS.map((e) => getPath(data, e.path)), error: '' };
    } catch (e) {
      return { values: SETTINGS.map(() => undefined), error: e.message };
    }
  };
  const [state, setState] = useState(load);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');
  // Factory defaults of the gating flags, read from the binary.
  const [defaults, setDefaults] = useState(null);
  useEffect(() => {
    let live = true;
    readFlagCatalog(binary)
      .then((cat) => live && setDefaults(Object.fromEntries(cat.map((f) => [f.statsigName, f.baseDefault]))))
      .catch(() => live && setDefaults({}));
    return () => {
      live = false;
    };
  }, []);

  const cycle = () => {
    const entry = SETTINGS[index];
    const cur = state.values[index];
    // A custom value (e.g. a custom output style id) stays in the cycle.
    const base = entry.type === 'boolean' ? [true, false] : entry.values;
    const options = [undefined, ...base, ...(cur !== undefined && !base.includes(cur) ? [cur] : [])];
    const next = options[(options.findIndex((o) => o === cur) + 1) % options.length];
    try {
      updateFactorySettings([{ path: entry.path, value: next }]);
      setState(load());
      setStatus(`${entry.key} → ${show(next)}`);
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }));
    }
  };

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i > 0 ? i - 1 : SETTINGS.length - 1));
    else if (key.downArrow) setIndex((i) => (i < SETTINGS.length - 1 ? i + 1 : 0));
    else if (input === ' ' || key.return) cycle();
    else if (key.escape || input === 'q') onBack();
  });

  const entry = SETTINGS[index];
  const forced = readFlagsOverrides();
  const server = readCachedServerFlags();
  const width = Math.max(...SETTINGS.map((e) => e.key.length)) + 2;
  const flagOn = entry.flag ? (forced[entry.flag] ?? server[entry.flag] ?? defaults?.[entry.flag]) : true;
  const why = forced[entry.flag] === false ? 'forced OFF' : server[entry.flag] === false ? 'off on the server' : 'off by default';
  const flagWarning =
    flagOn === false ? `${entry.flag} is ${why}; force it ON in Feature Flags, or Droid ${entry.flagEffect ?? 'ignores this setting'}.` : null;

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>Droid Settings<//>
      <${Text} dimColor>${factorySettingsPath()} · written right away, no Apply needed · restart Droid sessions<//>
      <${Box} flexDirection="column" marginTop=${1}>
        ${SETTINGS.map((e, i) => {
          const selected = i === index;
          const v = state.values[i];
          return html`
            <${Box} key=${e.key}>
              <${Text} color=${selected ? theme.accent : v === undefined ? theme.dim : undefined} bold=${selected}
                >${selected ? '❯ ' : '  '}${e.key.padEnd(width)}${show(v)}<//
              >
              <${Text} dimColor>${v === undefined && e.droidDefault !== undefined ? `  (Droid default ${JSON.stringify(e.droidDefault)})` : ''}<//>
            <//>
          `;
        })}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="round" borderColor=${theme.dim} paddingX=${1}>
        <${Text}>${entry.description}<//>
        ${flagWarning ? html`<${Text} color=${theme.warn}>⚠ ${flagWarning}<//>` : null}
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        ${state.error ? html`<${Text} color=${theme.err}>✗ ${state.error}<//>` : status ? html`<${Text} color=${theme.ok}>✓ ${status}<//>` : null}
        <${Text} dimColor>space/enter cycle value (unset = Droid decides) · ↑↓ move · esc back<//>
      <//>
    <//>
  `;
}
