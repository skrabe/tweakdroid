import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { html, theme, runEngine } from '../helpers.mjs';
import { SelectInput } from '../components/SelectInput.mjs';

// Drives the CLI engine: dry-run preview, apply, restore, re-extract.
export function ApplyView({ binary, onBack }) {
  const bin = binary ? ['--binary', binary] : [];
  const ACTIONS = [
    { label: 'Dry-run (preview what would change)', args: ['--apply', '--dry-run'] },
    { label: 'Apply (patch the binary)', args: ['--apply'] },
    { label: 'Restore factory', args: ['--restore'] },
    { label: 'Re-extract prompts from binary', args: ['--extract'] },
  ];

  const [index, setIndex] = useState(0);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(true);

  const run = (args, label) => {
    setRunning(true);
    setOutput(`${label}…`);
    // Defer so Ink paints the "running" frame before the blocking spawn.
    setTimeout(() => {
      const r = runEngine([...args, ...bin]);
      setOutput(r.out || '(no output)');
      setRunning(false);
    }, 30);
  };

  useEffect(() => {
    run(['--apply', '--dry-run'], 'Checking status');
  }, []);

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') onBack();
    },
    { isActive: !running }
  );

  const onSubmit = (i) => {
    const a = ACTIONS[i];
    run(a.args, a.label);
  };

  const items = ACTIONS.map((a) => ({ label: a.label }));

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Text} bold color=${theme.accent}>Apply / Status<//>
      <${Text} dimColor>${binary || 'auto-detected droid binary'}<//>
      <${Box} marginTop=${1}>
        <${SelectInput}
          items=${items}
          selectedIndex=${index}
          onSelect=${setIndex}
          onSubmit=${onSubmit}
          isActive=${!running}
        />
      <//>
      <${Box}
        marginTop=${1}
        borderStyle="round"
        borderColor=${theme.dim}
        paddingX=${1}
        flexDirection="column"
      >
        ${(output || '').split('\n').slice(0, 40).map((line, i) => {
          const color = /would change|Applied|Restored|Extracted/.test(line)
            ? theme.ok
            : /error|Error|not found|Unterminated|cannot/i.test(line)
              ? theme.err
              : /no changes|No /.test(line)
                ? theme.dim
                : undefined;
          return html`<${Text} key=${i} color=${color}>${line || ' '}<//>`;
        })}
      <//>
      <${Box} marginTop=${1}
        ><${Text} dimColor
          >${running ? 'running…' : '↑↓ move · enter run · esc back'}<//
        ><//
      >
    <//>
  `;
}
