import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  html,
  theme,
  readFlagCatalog,
  readFlagsOverrides,
  writeFlagsOverrides,
} from '../helpers.mjs';

const PAGE = 16;
const NOTABLE = new Set(['alloy', 'loop_command', 'squad', 'sub_agents_v2', 'ultra_plan', 'mcp_tool_search']);

// Toggle Statsig feature-flag defaults. Overrides are stored in
// feature-flags.json and written into the binary by the engine on Apply.
export function FeatureFlagsView({ binary, onBack }) {
  const [flags, setFlags] = useState(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const cat = readFlagCatalog(binary);
    // notable flags first, then the rest alphabetically by displayName
    cat.sort((a, b) => {
      const an = NOTABLE.has(a.statsigName) ? 0 : 1;
      const bn = NOTABLE.has(b.statsigName) ? 0 : 1;
      if (an !== bn) return an - bn;
      return a.displayName.localeCompare(b.displayName);
    });
    setFlags(cat);
  }, []);

  const toggle = () => {
    const f = flags[index];
    const desired = !f.effective;
    const overrides = readFlagsOverrides();
    if (desired === f.baseDefault) delete overrides[f.statsigName];
    else overrides[f.statsigName] = desired;
    writeFlagsOverrides(overrides);
    const next = flags.slice();
    next[index] = {
      ...f,
      override: desired === f.baseDefault ? undefined : desired,
      effective: desired,
    };
    setFlags(next);
    setStatus(`${f.displayName} → ${desired ? 'ON' : 'OFF'}`);
  };

  const clearAll = () => {
    writeFlagsOverrides({});
    setFlags(flags.map((f) => ({ ...f, override: undefined, effective: f.baseDefault })));
    setStatus('cleared all overrides');
  };

  useInput((input, key) => {
    if (!flags) return;
    if (key.upArrow) setIndex((i) => (i > 0 ? i - 1 : flags.length - 1));
    else if (key.downArrow) setIndex((i) => (i < flags.length - 1 ? i + 1 : 0));
    else if (input === ' ') toggle();
    else if (input === 'a') clearAll();
    else if (key.escape || input === 'q') onBack();
  });

  if (flags === null) {
    return html`<${Box} padding=${1}><${Text}>Reading feature flags from the binary…<//><//>`;
  }
  if (flags.length === 0) {
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} color=${theme.err}>No feature flags found (is droid on PATH?)<//>
        <${Box} marginTop=${1}><${Text} dimColor>esc back<//><//>
      <//>
    `;
  }

  const offset = Math.max(
    0,
    Math.min(index - Math.floor(PAGE / 2), flags.length - PAGE)
  );
  const visible = flags.slice(offset, offset + PAGE);
  const overrideCount = flags.filter((f) => f.override !== undefined).length;

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>Feature Flags<//>
      <${Text} dimColor
        >Toggle preview features; Apply writes them into the binary defaults.<//
      >
      <${Box} flexDirection="column" marginTop=${1}>
        ${visible.map((f, i) => {
          const idx = offset + i;
          const selected = idx === index;
          const box = f.effective ? '[✓]' : '[ ]';
          const changed = f.override !== undefined;
          const color = selected
            ? theme.accent
            : NOTABLE.has(f.statsigName)
              ? 'white'
              : undefined;
          return html`
            <${Box} key=${f.statsigName}>
              <${Text} color=${color} bold=${selected}>
                ${selected ? '❯ ' : '  '}${box} ${f.displayName}
              <//>
              <${Text} dimColor> ${f.statsigName}${changed ? ' *' : ''}<//>
            <//>
          `;
        })}
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        ${status ? html`<${Text} color=${theme.ok}>✓ ${status}<//>` : null}
        <${Text} dimColor
          >space toggle · a clear all · ↑↓ move · esc back ${' '}
          ${'·'} ${overrideCount} override${overrideCount === 1 ? '' : 's'} (* = differs from default)<//
        >
      <//>
    <//>
  `;
}
