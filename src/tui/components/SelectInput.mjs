import { Box, Text, useInput } from 'ink';
import { html } from '../helpers.mjs';

// Generic vertical list. items: [{ label, desc, color }]. Controlled via
// selectedIndex/onSelect; Enter fires onSubmit(index). isActive gates input.
export function SelectInput({
  items,
  selectedIndex,
  onSelect,
  onSubmit,
  isActive = true,
}) {
  useInput(
    (input, key) => {
      if (key.upArrow) {
        onSelect(selectedIndex > 0 ? selectedIndex - 1 : items.length - 1);
      } else if (key.downArrow) {
        onSelect(selectedIndex < items.length - 1 ? selectedIndex + 1 : 0);
      } else if (key.return) {
        onSubmit && onSubmit(selectedIndex);
      }
    },
    { isActive }
  );

  return html`
    <${Box} flexDirection="column">
      ${items.map((item, index) => {
        const selected = index === selectedIndex;
        return html`
          <${Box} key=${index}>
            <${Text}
              bold=${selected}
              color=${selected ? item.color || 'cyan' : item.color}
            >
              ${selected ? '❯ ' : '  '}${item.label}
            <//>
            ${item.desc && selected
              ? html`<${Text} dimColor> ${'—'} ${item.desc}<//>`
              : null}
          <//>
        `;
      })}
    <//>
  `;
}
