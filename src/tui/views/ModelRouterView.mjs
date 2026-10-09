import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  html,
  theme,
  routerRows,
  readCustomModels,
  readRouterMap,
  writeRouterMap,
} from '../helpers.mjs';
import { SelectInput } from '../components/SelectInput.mjs';

// Maps each Factory Router label (or the classifier's label group) -> one of the
// user's `custom:` models, written to router-byok-map.json (consumed by the
// engine's applyRouterByokRemap). Labels are read from the installed binary.
export function ModelRouterView({ binary, onBack }) {
  const [models, setModels] = useState(null); // null = loading
  const [rows, setRows] = useState([]);
  const [map, setMap] = useState(() => readRouterMap());
  const [tierIndex, setTierIndex] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all([routerRows(binary, readRouterMap()), readCustomModels(binary)]).then(([r, m]) => {
      if (!live) return;
      setRows(r);
      setModels(m);
    });
    return () => {
      live = false;
    };
  }, []);

  // A row shows the mapping of its preferred (first) label; grouped rows also
  // list any of their labels that are unmapped.
  const rowValue = (row) => map[row.keys[0]];
  const unmappedKeys = (row) => row.keys.filter((k) => !map[k]);
  const ready = models !== null && rows.length > 0;

  // While loading, swallow keystrokes (only esc/q leave). Without an active
  // handler Ink drops raw mode and the terminal would replay them once the
  // list appears.
  useInput(
    (input, key) => {
      if (key.escape || input === 'q') onBack();
    },
    { isActive: !ready }
  );

  // Label-list navigation (active only when not picking a model).
  useInput(
    (input, key) => {
      if (key.upArrow)
        setTierIndex((i) => (i > 0 ? i - 1 : rows.length - 1));
      else if (key.downArrow)
        setTierIndex((i) => (i < rows.length - 1 ? i + 1 : 0));
      else if (key.return) {
        if (!models || models.length === 0) {
          setStatus('no custom models found — configure them in ~/.factory');
          return;
        }
        const cur = rowValue(rows[tierIndex]);
        const idx = Math.max(
          0,
          models.findIndex((m) => m.id === cur)
        );
        setPickIndex(idx);
        setPicking(true);
      } else if (input === 'x') {
        const next = { ...map };
        for (const key of rows[tierIndex].keys) delete next[key];
        setMap(next);
        writeRouterMap(next);
        setStatus(`cleared ${rows[tierIndex].label}`);
      } else if (key.escape || input === 'q') {
        onBack();
      }
    },
    { isActive: ready && !picking }
  );

  // Cancel the picker on escape.
  useInput(
    (input, key) => {
      if (key.escape) setPicking(false);
    },
    { isActive: picking }
  );

  const onPick = (idx) => {
    const tier = rows[tierIndex];
    const model = models[idx];
    const next = { ...map };
    for (const key of tier.keys) next[key] = model.id;
    setMap(next);
    writeRouterMap(next);
    setStatus(`${tier.label} → ${model.label}`);
    setPicking(false);
  };

  if (!ready) {
    return html`<${Box} padding=${1}><${Text}
        >Loading your custom models from ~/.factory…<//
      ><//>`;
  }

  if (picking) {
    const tier = rows[tierIndex];
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

  const width = Math.max(...rows.map((r) => r.label.length)) + 2;
  const items = rows.map((t) => {
    const id = rowValue(t);
    const model = id ? models.find((m) => m.id === id) : null;
    const val = id ? (model ? model.label : id) : '(unset)';
    const missing = t.keys.length > 1 ? unmappedKeys(t) : [];
    const partial = missing.length > 0 && missing.length < t.keys.length;
    return {
      label: `${t.label.padEnd(width)}${val}${partial ? `  ⚠ unmapped: ${missing.join(', ')}` : ''}`,
      desc: t.help,
      color: (model && model.malformed) || partial ? theme.warn : id && !t.legacy ? undefined : theme.dim,
    };
  });

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}
        >Model Router — Auto Model → your BYOK models<//
      >
      <${Text} dimColor
        >Each label Auto Model can pick resolves to one of your ~/.factory custom models.<//
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
          >↑↓ label · enter change · x clear · esc back<//
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
