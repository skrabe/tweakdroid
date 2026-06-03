import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  html,
  theme,
  ROUTER_TIERS,
  readCustomModels,
  readRouterMap,
  writeRouterMap,
} from '../helpers.mjs';
import { SelectInput } from '../components/SelectInput.mjs';

// Maps each Factory Router tier -> one of the user's `custom:` models, written
// to router-byok-map.json (consumed by the engine's applyRouterByokRemap).
export function ModelRouterView({ binary, onBack }) {
  const [models, setModels] = useState(null); // null = loading
  const [map, setMap] = useState(() => readRouterMap());
  const [tierIndex, setTierIndex] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setModels(readCustomModels(binary));
  }, []);

  // Tier-list navigation (active only when not picking a model).
  useInput(
    (input, key) => {
      if (key.upArrow)
        setTierIndex((i) => (i > 0 ? i - 1 : ROUTER_TIERS.length - 1));
      else if (key.downArrow)
        setTierIndex((i) => (i < ROUTER_TIERS.length - 1 ? i + 1 : 0));
      else if (key.return) {
        if (!models || models.length === 0) {
          setStatus('no custom models found — configure them in ~/.factory');
          return;
        }
        const cur = map[ROUTER_TIERS[tierIndex].key];
        const idx = Math.max(
          0,
          models.findIndex((m) => m.id === cur)
        );
        setPickIndex(idx);
        setPicking(true);
      } else if (input === 'x') {
        const next = { ...map };
        delete next[ROUTER_TIERS[tierIndex].key];
        setMap(next);
        writeRouterMap(next);
        setStatus(`cleared ${ROUTER_TIERS[tierIndex].label}`);
      } else if (key.escape || input === 'q') {
        onBack();
      }
    },
    { isActive: !picking }
  );

  // Cancel the picker on escape.
  useInput(
    (input, key) => {
      if (key.escape) setPicking(false);
    },
    { isActive: picking }
  );

  const onPick = (idx) => {
    const tier = ROUTER_TIERS[tierIndex];
    const model = models[idx];
    const next = { ...map, [tier.key]: model.id };
    setMap(next);
    writeRouterMap(next);
    setStatus(`${tier.label} → ${model.label}`);
    setPicking(false);
  };

  if (models === null) {
    return html`<${Box} padding=${1}><${Text}
        >Loading your custom models from ~/.factory…<//
      ><//>`;
  }

  if (picking) {
    const tier = ROUTER_TIERS[tierIndex];
    const items = models.map((m) => ({
      label: m.label + (m.malformed ? `  ⚠ malformed name (${m.model})` : ''),
      desc: m.model
        ? m.model + (m.provider ? ` · ${m.provider}` : '')
        : undefined,
      color: m.malformed ? theme.warn : undefined,
    }));
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} bold
          >Pick a model for <${Text} color=${theme.accent}>${tier.label}<//> ${' '}
          <${Text} dimColor>(${tier.help})<//><//
        >
        <${Box} marginTop=${1}>
          <${SelectInput}
            items=${items}
            selectedIndex=${pickIndex}
            onSelect=${setPickIndex}
            onSubmit=${onPick}
            isActive=${true}
          />
        <//>
        <${Box} marginTop=${1}
          ><${Text} dimColor>↑↓ move · enter select · esc cancel<//><//
        >
      <//>
    `;
  }

  const items = ROUTER_TIERS.map((t) => {
    const id = map[t.key];
    const model = id ? models.find((m) => m.id === id) : null;
    const val = id ? (model ? model.label : id) : '(unset)';
    return {
      label: `${t.label.padEnd(11)}${val}`,
      desc: t.help,
      color: model && model.malformed ? theme.warn : id ? undefined : theme.dim,
    };
  });

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}
        >Model Router — Auto Model → your BYOK models<//
      >
      <${Text} dimColor
        >Each Factory tier resolves to one of your ~/.factory custom models.<//
      >
      <${Box} marginTop=${1}>
        <${SelectInput}
          items=${items}
          selectedIndex=${tierIndex}
          isActive=${false}
        />
      <//>
      ${status
        ? html`<${Box} marginTop=${1}
            ><${Text} color=${theme.ok}>✓ ${status}<//><//
          >`
        : null}
      <${Box} marginTop=${1}
        ><${Text} dimColor
          >↑↓ tier · enter change · x clear · esc back<//
        ><//
      >
      <${Box}
        ><${Text} dimColor
          >${models.length} custom models · saved to router-byok-map.json<//
        ><//
      >
    <//>
  `;
}
