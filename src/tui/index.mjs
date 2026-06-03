#!/usr/bin/env node
import { useState } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { html, theme, droidBinary } from './helpers.mjs';
import { SelectInput } from './components/SelectInput.mjs';
import { ModelRouterView } from './views/ModelRouterView.mjs';
import { FeatureFlagsView } from './views/FeatureFlagsView.mjs';
import { PromptsView } from './views/PromptsView.mjs';
import { ApplyView } from './views/ApplyView.mjs';

const MENU = [
  { key: 'router', label: 'Model Router', desc: 'map Auto Model tiers to your BYOK models' },
  { key: 'flags', label: 'Feature Flags', desc: 'enable preview features (auto, /loop, squad…)' },
  { key: 'prompts', label: 'System Prompts', desc: 'edit prompt overrides' },
  { key: 'apply', label: 'Apply / Status', desc: 'patch the binary · dry-run · restore' },
  { key: 'exit', label: 'Exit', desc: '' },
];

function App({ binary }) {
  const [view, setView] = useState(null);
  const [menuIndex, setMenuIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow) setMenuIndex((i) => (i > 0 ? i - 1 : MENU.length - 1));
      else if (key.downArrow)
        setMenuIndex((i) => (i < MENU.length - 1 ? i + 1 : 0));
      else if (key.return) {
        const k = MENU[menuIndex].key;
        if (k === 'exit') process.exit(0);
        else setView(k);
      } else if (input === 'q' || key.escape) {
        process.exit(0);
      }
    },
    { isActive: !view }
  );

  const onBack = () => setView(null);

  if (view === 'router')
    return html`<${ModelRouterView} binary=${binary} onBack=${onBack} />`;
  if (view === 'flags')
    return html`<${FeatureFlagsView} binary=${binary} onBack=${onBack} />`;
  if (view === 'prompts')
    return html`<${PromptsView} binary=${binary} onBack=${onBack} />`;
  if (view === 'apply')
    return html`<${ApplyView} binary=${binary} onBack=${onBack} />`;

  const items = MENU.map((m) => ({ label: m.label, desc: m.desc }));
  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Box}>
        <${Text} bold color=${theme.accent}>tweakdroid<//>
        <${Text} dimColor> · Factory Droid customization<//>
      <//>
      <${Box} marginTop=${1} marginBottom=${1}>
        <${Text} dimColor
          >droid: ${binary || 'NOT FOUND on PATH — config views still work'}<//
        >
      <//>
      <${SelectInput} items=${items} selectedIndex=${menuIndex} isActive=${false} />
      <${Box} marginTop=${1}
        ><${Text} dimColor>↑↓ move · enter select · q quit<//><//
      >
    <//>
  `;
}

render(html`<${App} binary=${droidBinary()} />`);
