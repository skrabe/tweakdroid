import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { html, theme, TWEAKDROID_DIR } from '../helpers.mjs';

const SYSTEM_DIR = path.join(TWEAKDROID_DIR, 'system-prompts');
const EDITED_DIR = path.join(TWEAKDROID_DIR, 'edited-prompts');
const PAGE = 16;

const openInEditor = (file) => {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawnSync(cmd, [file], { stdio: 'ignore' });
};

const friendly = (f) => {
  const [name, , provider] = f
    .replace(/\.md$/, '')
    .replace(/^\d+-/, '')
    .split('__');
  const prov = (provider || '').replace(/-only$/, '').replace(/all-providers/, '');
  return name.replace(/-/g, ' ') + (prov ? ` · ${prov}` : '');
};

// Manage prompt overrides: list extracted prompts, mark which are overridden,
// open one for editing (copying the factory version on first edit), or revert.
export function PromptsView({ onBack }) {
  const [prompts, setPrompts] = useState(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');

  const load = () => {
    let files = [];
    try {
      files = fs.readdirSync(SYSTEM_DIR).filter((f) => f.endsWith('.md'));
    } catch {
      files = [];
    }
    files.sort();
    setPrompts(
      files.map((f) => ({
        file: f,
        name: friendly(f),
        edited: fs.existsSync(path.join(EDITED_DIR, f)),
      }))
    );
  };

  useEffect(load, []);

  useInput((input, key) => {
    if (!prompts || prompts.length === 0) {
      if (key.escape || input === 'q') onBack();
      return;
    }
    if (key.upArrow) setIndex((i) => (i > 0 ? i - 1 : prompts.length - 1));
    else if (key.downArrow)
      setIndex((i) => (i < prompts.length - 1 ? i + 1 : 0));
    else if (key.return) {
      const p = prompts[index];
      const edited = path.join(EDITED_DIR, p.file);
      if (!p.edited) {
        fs.mkdirSync(EDITED_DIR, { recursive: true });
        fs.copyFileSync(path.join(SYSTEM_DIR, p.file), edited);
      }
      openInEditor(edited);
      setStatus(`opened ${p.name} in your editor`);
      load();
    } else if (input === 'x') {
      const p = prompts[index];
      if (p.edited) {
        fs.rmSync(path.join(EDITED_DIR, p.file), { force: true });
        setStatus(`reverted ${p.name} to factory`);
        load();
      }
    } else if (key.escape || input === 'q') onBack();
  });

  if (prompts === null) {
    return html`<${Box} padding=${1}><${Text}>Loading prompts…<//><//>`;
  }
  if (prompts.length === 0) {
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} color=${theme.warn}>No extracted prompts found in ${SYSTEM_DIR}.<//>
        <${Text} dimColor>Run \`tweakdroid --extract\` first (or the Apply view).<//>
        <${Box} marginTop=${1}><${Text} dimColor>esc back<//><//>
      <//>
    `;
  }

  const offset = Math.max(
    0,
    Math.min(index - Math.floor(PAGE / 2), prompts.length - PAGE)
  );
  const visible = prompts.slice(offset, offset + PAGE);
  const editedCount = prompts.filter((p) => p.edited).length;

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>System Prompts<//>
      <${Text} dimColor
        >Enter opens a prompt for editing; Apply writes overrides into the binary.<//
      >
      <${Box} flexDirection="column" marginTop=${1}>
        ${visible.map((p, i) => {
          const idx = offset + i;
          const selected = idx === index;
          const tag = p.edited ? '[edited]' : '[factory]';
          return html`
            <${Box} key=${p.file}>
              <${Text}
                color=${selected ? theme.accent : p.edited ? theme.ok : undefined}
                bold=${selected}
              >
                ${selected ? '❯ ' : '  '}${tag} ${p.name}
              <//>
            <//>
          `;
        })}
      <//>
      <${Box} marginTop=${1} flexDirection="column">
        ${status ? html`<${Text} color=${theme.ok}>✓ ${status}<//>` : null}
        <${Text} dimColor
          >enter edit · x revert · ↑↓ move · esc back · ${editedCount} edited<//
        >
      <//>
    <//>
  `;
}
