import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  html,
  theme,
  readFlagCatalog,
  readFlagsOverrides,
  writeFlagsOverrides,
  setFlagOverride,
} from '../helpers.mjs';
import { FLAG_NOTES } from '../../catalog.mjs';

const PAGE = 14;
const NEXT = { default: true, true: false, false: 'default' };
const keyOf = (forced) => (forced === undefined ? 'default' : String(forced));

const onOff = (v) => (v === true ? 'on' : v === false ? 'off' : '?');

// Force Statsig feature flags on or off. Choices are stored in
// feature-flags.json and patched into the binary by the engine on Apply.
export function FeatureFlagsView({ binary, onBack }) {
  const [flags, setFlags] = useState(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    readFlagCatalog(binary).catch((e) => {
      if (live) setError(e.message);
      return [];
    }).then((cat) => {
      if (!live) return;
      // Flags with notes first (in catalog order), then the rest by name.
      const order = Object.keys(FLAG_NOTES);
      cat.sort((a, b) => {
        const ai = order.indexOf(a.statsigName);
        const bi = order.indexOf(b.statsigName);
        if (ai !== bi) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
        return a.displayName.localeCompare(b.displayName);
      });
      setFlags(cat);
    });
    return () => {
      live = false;
    };
  }, []);

  const cycle = () => {
    const flag = flags[index];
    const nextKey = NEXT[keyOf(flag.override)];
    const override = nextKey === 'default' ? undefined : nextKey;
    // Touch only this key of the file, so other edits made meanwhile survive.
    const file = setFlagOverride(flag.statsigName, override);
    setFlags(flags.map((x) => {
      const o = typeof file[x.statsigName] === 'boolean' ? file[x.statsigName] : undefined;
      return { ...x, override: o, effective: o ?? x.server ?? x.baseDefault };
    }));
    setStatus(`${flag.statsigName} → ${override === undefined ? 'not forced' : `forced ${override ? 'ON' : 'OFF'}`}`);
  };

  // Stop forcing every flag this binary has; names it does not list stay.
  const clearAll = () => {
    const current = readFlagsOverrides();
    for (const x of flags) delete current[x.statsigName];
    writeFlagsOverrides(current);
    setFlags(flags.map((x) => ({ ...x, override: undefined, effective: x.server ?? x.baseDefault })));
    setStatus('stopped forcing every flag');
  };

  useInput((input, key) => {
    if (!flags || flags.length === 0) {
      if (key.escape || input === 'q') onBack();
      return;
    }
    if (key.upArrow) setIndex((i) => (i > 0 ? i - 1 : flags.length - 1));
    else if (key.downArrow) setIndex((i) => (i < flags.length - 1 ? i + 1 : 0));
    else if (key.pageDown) setIndex((i) => Math.min(flags.length - 1, i + PAGE));
    else if (key.pageUp) setIndex((i) => Math.max(0, i - PAGE));
    else if (input === ' ' || key.return) cycle();
    else if (input === 'a') clearAll();
    else if (key.escape || input === 'q') onBack();
  });

  if (flags === null) {
    return html`<${Box} padding=${1}><${Text}>Reading feature flags from the binary…<//><//>`;
  }
  if (flags.length === 0) {
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} color=${theme.err}>${error || 'No feature flags found in this binary.'}<//>
        <${Box} marginTop=${1}><${Text} dimColor>esc back<//><//>
      <//>
    `;
  }

  const offset = Math.max(0, Math.min(index - Math.floor(PAGE / 2), flags.length - PAGE));
  const visible = flags.slice(offset, offset + PAGE);
  const forcedCount = flags.filter((f) => f.override !== undefined).length;
  const current = flags[index];
  const note = FLAG_NOTES[current.statsigName];

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>Feature Flags<//>
      <${Text} dimColor
        >Force Statsig flags ON or OFF; Apply patches the choice into the binary over the server value.<//
      >
      <${Box} flexDirection="column" marginTop=${1}>
        ${visible.map((f, i) => {
          const selected = offset + i === index;
          const tag = f.override === true ? '[ON ]' : f.override === false ? '[OFF]' : '[ - ]';
          const color = selected ? theme.accent : f.override !== undefined ? theme.ok : FLAG_NOTES[f.statsigName] ? 'white' : undefined;
          return html`
            <${Box} key=${f.statsigName}>
              <${Text} color=${color} bold=${selected}>${selected ? '❯ ' : '  '}${tag} ${f.displayName}<//>
              <${Text} dimColor> ${f.statsigName} · server ${onOff(f.server)} · default ${onOff(f.baseDefault)}<//>
            <//>
          `;
        })}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="round" borderColor=${theme.dim} paddingX=${1}>
        <${Text} bold>${current.displayName}<//>
        <${Text}>${note ? note.text : 'No notes for this flag; forcing it only makes the client treat the feature as enabled.'}<//>
        ${note && note.needs ? html`<${Text} color=${theme.warn}>Also needs: ${note.needs}<//>` : null}
        <${Text} dimColor
          >now: ${describeState(current)}<//
        >
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        ${status ? html`<${Text} color=${theme.ok}>✓ ${status}<//>` : null}
        <${Text} dimColor
          >space/enter cycle not forced → ON → OFF · a stop forcing all · ↑↓ PgUp PgDn move · esc back · ${forcedCount} forced<//
        >
      <//>
    <//>
  `;
}

function describeState(flag) {
  if (flag.override !== undefined) return `forced ${flag.override ? 'ON' : 'OFF'} (after Apply)`;
  if (flag.server !== null && flag.server !== undefined) return `${flag.server ? 'ON' : 'OFF'} from the server (last cached value)`;
  return `${flag.baseDefault ? 'ON' : 'OFF'} by default (no cached server value)`;
}
