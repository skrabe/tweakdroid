import { Box, Text, useInput } from 'ink';
import { html } from '../helpers.mjs';

// Generic vertical list. items: [{ label, desc, color }]. Controlled via
// selectedIndex/onSelect; Enter fires onSubmit(index). isActive gates input.
// Long lists scroll in a window of `limit` rows around the selection.
export function SelectInput({
  items,
  selectedIndex,
  onSelect,
  onSubmit,
  isActive = true,
  limit = 20,
}) {
  useInput(
    (input, key) => {
      if (key.upArrow) {
        onSelect(selectedIndex > 0 ? selectedIndex - 1 : items.length - 1);
      } else if (key.downArrow) {
        onSelect(selectedIndex < items.length - 1 ? selectedIndex + 1 : 0);
      } else if (key.pageUp) {
        onSelect(Math.max(0, selectedIndex - limit));
      } else if (key.pageDown) {
        onSelect(Math.min(items.length - 1, selectedIndex + limit));
      } else if (key.return) {
        onSubmit && onSubmit(selectedIndex);
      }
    },
    { isActive }
  );

  const offset =
    items.length <= limit ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(limit / 2), items.length - limit));
  const visible = items.slice(offset, offset + limit);

  return html`
    <${Box} flexDirection="column">
      ${offset > 0 ? html`<${Text} dimColor>  ↑ ${offset} more<//>` : null}
      ${visible.map((item, i) => {
        const index = offset + i;
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
      ${offset + limit < items.length ? html`<${Text} dimColor>  ↓ ${items.length - offset - limit} more<//>` : null}
    <//>
  `;
}
