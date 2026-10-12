import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  html,
  theme,
  readCustomModels,
  readRouterLabels,
  TWEAKDROID_DIR,
} from '../helpers.mjs';
import { SelectInput } from '../components/SelectInput.mjs';
import {
  nativeByokStatus,
  setNativeByokPolicy,
  assignNativeByok,
  unassignNativeByok,
  customEligibility,
} from '../../native-byok.mjs';

const POLICY_HELP = {
  allowFactoryRouterByok: 'model-policy gate: Droid only looks for BYOK router models when this is true',
  factoryRouterByokOnly: 'drop every label without a BYOK model instead of sending it to Factory',
};
const NEXT_POLICY = { undefined: true, true: false, false: undefined };

// Droid's native Auto Model BYOK: the model-policy gate in
// ~/.factory/settings.json, and per label the custom model marked
// useInRouter + baseModelId. Settings are written immediately. (Droid 0.239
// no longer reads the alloy_byok flag; the policy gate alone turns it on.)
export function NativeByokView({ binary, onBack }) {
  const [labels, setLabels] = useState(null);
  const [models, setModels] = useState([]);
  const [status, setStatus] = useState(null);
  const [index, setIndex] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Re-read settings; returns an error message ('' when fine).
  const refresh = (ls = labels) => {
    try {
      setStatus(nativeByokStatus(ls.map((l) => l.id), TWEAKDROID_DIR));
      return '';
    } catch (e) {
      setStatus(null);
      return e.message;
    }
  };

  useEffect(() => {
    let live = true;
    Promise.all([readRouterLabels(binary), readCustomModels(binary)]).then(([l, m]) => {
      if (!live) return;
      const ls = [
        ...l.classifiers.filter((id) => !l.candidates.includes(id)).map((id) => ({ id, role: 'classifier' })),
        ...l.candidates.map((id) => ({ id, role: 'candidate' })),
        ...(l.fastCandidates ?? [])
          .filter((id) => !l.candidates.includes(id) && !l.classifiers.includes(id))
          .map((id) => ({ id, role: 'auto-fast' })),
      ];
      setLabels(ls);
      setModels(m);
      setError(refresh(ls));
    });
    return () => {
      live = false;
    };
  }, []);

  const ready = labels !== null;
  const rows = ready
    ? [
        { kind: 'policy', key: 'allowFactoryRouterByok' },
        { kind: 'policy', key: 'factoryRouterByokOnly' },
        ...labels.map((l) => ({ ...l, kind: 'label' })),
      ]
    : [];

  const act = (fn) => {
    let failure = '';
    const before = new Set((status?.copies ?? []).map((c) => c.id));
    try {
      setMessage(fn());
    } catch (e) {
      failure = e.message;
    }
    setError(failure || refresh());
    // Drop copies that the action deleted from the picker.
    try {
      const after = new Set(nativeByokStatus(labels.map((l) => l.id), TWEAKDROID_DIR).copies.map((c) => c.id));
      const gone = [...before].filter((id) => !after.has(id));
      if (gone.length) setModels((ms) => ms.filter((m) => !gone.includes(m.id)));
    } catch {
      // the error is already shown
    }
  };

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') onBack();
    },
    { isActive: !ready }
  );

  useInput(
    (input, key) => {
      const row = rows[index];
      if (!status && !(key.upArrow || key.downArrow || key.escape || input === 'q')) return;
      if (key.upArrow) setIndex((i) => (i > 0 ? i - 1 : rows.length - 1));
      else if (key.downArrow) setIndex((i) => (i < rows.length - 1 ? i + 1 : 0));
      else if (key.return || input === ' ') {
        if (row.kind === 'policy') {
          const cur = status.policy.user[row.key];
          const next = NEXT_POLICY[String(cur)];
          act(() => (setNativeByokPolicy(row.key, next), `modelPolicy.${row.key} → ${next === undefined ? 'unset' : next}`));
        } else if (row.kind === 'label') {
          if (models.length === 0) return setError('no custom models found — configure them in ~/.factory/settings.json');
          const cur = status.assignments[row.id]?.id;
          setPickIndex(Math.max(0, models.findIndex((m) => m.id === cur)));
          setPicking(true);
        }
      } else if (input === 'x' && row.kind === 'label') {
        act(() => {
          const removed = unassignNativeByok(row.id, TWEAKDROID_DIR);
          return removed.length ? `${row.id} no longer routed natively` : `${row.id} had no native BYOK model`;
        });
      } else if (key.escape || input === 'q') onBack();
    },
    { isActive: Boolean(ready) && !picking }
  );

  useInput(
    (input, key) => {
      if (key.escape) setPicking(false);
    },
    { isActive: picking }
  );

  if (!ready) {
    return html`<${Box} padding=${1}><${Text}>Loading Auto Model labels and your custom models…<//><//>`;
  }

  const servedBy = (id) =>
    Object.entries(status?.assignments ?? {}).filter(([, a]) => a && a.id === id).map(([label]) => label);

  if (picking) {
    const row = rows[index];
    const onPick = (i) => {
      const model = models[i];
      setPicking(false);
      act(() => {
        const r = assignNativeByok(row.id, model.id, labels.map((l) => l.id), TWEAKDROID_DIR);
        if (r.copied && !models.some((m) => m.id === r.id)) {
          setModels((ms) => [...ms, { id: r.id, label: `${model.label} [Auto ${row.id}]`, model: model.model, provider: model.provider }]);
        }
        return r.unchanged
          ? `${row.id} already routes to ${model.label}`
          : r.copied
          ? `${row.id} → copy of ${model.label} (${r.id}); a custom model serves one label natively`
          : `${row.id} → ${model.label}`;
      });
    };
    let fit = {};
    try {
      fit = customEligibility();
    } catch {
      fit = {};
    }
    const items = models.map((m) => {
      const others = servedBy(m.id).filter((l) => l !== row.id);
      const e = fit[m.id];
      return {
        label:
          m.label +
          (e && !e.ok ? `  ✗ Droid would skip it: ${e.reason}` : others.length ? `  (serves ${others.join(', ')}; picking adds a copy)` : ''),
        desc: m.model ? m.model + (m.provider ? ` · ${m.provider}` : '') : undefined,
        color: e && !e.ok ? theme.err : m.malformed ? theme.warn : undefined,
      };
    });
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} bold>Native BYOK model for <${Text} color=${theme.accent}>${row.id}<//> <${Text} dimColor>(${row.role})<//><//>
        <${Box} marginTop=${1}>
          <${SelectInput} items=${items} selectedIndex=${pickIndex} onSelect=${setPickIndex} onSubmit=${onPick} isActive=${true} />
        <//>
        <${Box} marginTop=${1}><${Text} dimColor>↑↓ move · enter select · esc cancel<//><//>
      <//>
    `;
  }

  const policy = status?.policy ?? { user: {}, org: {}, effective: {} };
  const width = Math.max(24, ...labels.map((l) => l.id.length + 2));
  const items = rows.map((row) => {
    if (row.kind === 'policy') {
      const user = policy.user[row.key];
      const org = policy.org[row.key];
      const shown = `${user === undefined ? 'unset' : user}${org !== undefined ? `  (org policy says ${org} and wins)` : ''}`;
      return { label: `${row.key.padEnd(width)}${shown}`, desc: POLICY_HELP[row.key], color: org !== undefined && org !== user ? theme.warn : undefined };
    }
    const a = status?.assignments[row.id];
    return {
      label: `${row.id.padEnd(width)}${a ? a.displayName + (a.copy ? '  [tweakdroid copy]' : '') : '(none)'}`,
      desc:
        row.role === 'classifier'
          ? 'classifier label; Droid uses the first classifier label that has a BYOK model'
          : row.role === 'auto-fast'
            ? 'candidate of the auto-fast model (alloy_fast flag)'
            : 'Auto Model candidate',
      color: a ? undefined : theme.dim,
    };
  });

  const warnings = [];
  if (policy.effective.allowFactoryRouterByok !== true) warnings.push('allowFactoryRouterByok is not true: Droid finds no BYOK router models.');
  if (policy.effective.allowCustomModels === false) warnings.push('the model policy disables custom models: Droid finds no BYOK router models.');
  for (const sk of status?.skipped ?? []) warnings.push(`${sk.label}: Droid skips ${sk.id} (${sk.reason})`);
  for (const s of status?.strays ?? []) warnings.push(`${s.id} has useInRouter=${s.useInRouter} baseModelId=${s.baseModelId ?? 'unset'} (not an active assignment)`);

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>Native Auto Model BYOK<//>
      <${Text} dimColor>Droid's own BYOK routing. Labels routed here win over the Model Router remap; the remap still covers the rest.<//>
      <${Box} marginTop=${1}>
        <${SelectInput} items=${items} selectedIndex=${index} isActive=${false} limit=${26} />
      <//>
      ${warnings.map((w, i) => html`<${Text} key=${i} color=${theme.warn}>⚠ ${w}<//>`)}
      ${error ? html`<${Text} color=${theme.err}>✗ ${error}<//>` : message ? html`<${Text} color=${theme.ok}>✓ ${message}<//>` : null}
      <${Box} marginTop=${1}><${Text} dimColor>↑↓ move · enter change/cycle · x unassign label · esc back · settings.json is written immediately<//><//>
    <//>
  `;
}
