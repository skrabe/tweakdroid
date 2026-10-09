import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { html, theme, runEngineAsync } from '../helpers.mjs';
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
    runEngineAsync([...args, ...bin]).then((r) => {
      setOutput(r.out || '(no output)');
      setRunning(false);
    });
  };

  useEffect(() => {
    run(['--apply', '--dry-run'], 'Checking status');
  }, []);

  // Always listen (keystrokes typed while the engine runs are swallowed rather
  // than replayed afterwards); leaving is only allowed once it has finished.
  useInput((input, key) => {
    if (!running && (key.escape || input === 'q')) onBack();
  });

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
