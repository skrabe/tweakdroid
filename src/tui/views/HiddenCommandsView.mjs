import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { html, theme, runEngineAsync, readJson, writeJson, UNHIDE_FILE } from '../helpers.mjs';
import fs from 'node:fs';

// Show Droid's hidden subcommands in `droid --help` (and the Script-tool
// options in `droid exec --help`). Choices go to unhide.json; Apply patches.
export function HiddenCommandsView({ binary, onBack }) {
  const [rows, setRows] = useState(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let live = true;
    runEngineAsync(['--list-hidden', ...(binary ? ['--binary', binary] : [])]).then((r) => {
      if (!live) return;
      try {
        setRows(JSON.parse(r.out));
      } catch {
        setRows([]);
        setStatus(r.out.split('\n')[0] || 'could not read the binary');
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const toggle = () => {
    const row = rows[index];
    const choices = readJson(UNHIDE_FILE, {}) || {};
    const next = !row.unhide;
    if (next) choices[row.name] = true;
    else delete choices[row.name];
    if (Object.keys(choices).length === 0) fs.rmSync(UNHIDE_FILE, { force: true });
    else writeJson(UNHIDE_FILE, choices);
    setRows(rows.map((r, i) => (i === index ? { ...r, unhide: next } : r)));
    setStatus(`${row.name} → ${next ? 'shown' : 'hidden'} after Apply`);
  };

  useInput((input, key) => {
    if (!rows || rows.length === 0) {
      if (key.escape || input === 'q') onBack();
      return;
    }
    if (key.upArrow) setIndex((i) => (i > 0 ? i - 1 : rows.length - 1));
    else if (key.downArrow) setIndex((i) => (i < rows.length - 1 ? i + 1 : 0));
    else if (input === ' ' || key.return) toggle();
    else if (key.escape || input === 'q') onBack();
  });

  if (rows === null) return html`<${Box} padding=${1}><${Text}>Reading hidden commands from the binary…<//><//>`;
  if (rows.length === 0) {
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} color=${theme.err}>No hidden commands found. ${status}<//>
        <${Box} marginTop=${1}><${Text} dimColor>esc back<//><//>
      <//>
    `;
  }
  const current = rows[index];
  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>Hidden Commands<//>
      <${Text} dimColor>These work when typed; showing them only lists them in droid --help. Apply patches the binary.<//>
      <${Box} flexDirection="column" marginTop=${1}>
        ${rows.map((r, i) => {
          const selected = i === index;
          return html`
            <${Box} key=${r.name}>
              <${Text} color=${selected ? theme.accent : !r.available ? theme.err : r.unhide ? theme.ok : undefined} bold=${selected}
                >${selected ? '❯ ' : '  '}${r.unhide ? '[shown ]' : '[hidden]'} ${r.name}<//
              >
              ${!r.available ? html`<${Text} color=${theme.err}> not patchable: ${r.problem}<//>` : null}
            <//>
          `;
        })}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="round" borderColor=${theme.dim} paddingX=${1}>
        <${Text}>${current.description}<//>
        ${current.needs ? html`<${Text} color=${theme.warn}>Needs: ${current.needs}<//>` : null}
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        ${status ? html`<${Text} color=${theme.ok}>✓ ${status}<//>` : null}
        <${Text} dimColor>space/enter toggle · ↑↓ move · esc back<//>
      <//>
    <//>
  `;
}
