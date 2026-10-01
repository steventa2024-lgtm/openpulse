import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  keywords?: string;
}

/**
 * Ctrl+K: jump to any screen by typing part of its name. Arrow keys move, Enter opens,
 * Escape closes.
 */
export function CommandPalette({
  items,
  onPick,
  onClose,
}: {
  items: PaletteItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.label} ${item.group} ${item.keywords ?? ''}`.toLowerCase().includes(needle),
    );
  }, [items, query]);

  useEffect(() => inputRef.current?.focus(), []);

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    onPick(item.id);
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Go to a screen"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Go to… (projects, changes, models, tests)"
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter') pick(matches[index]);
          }}
        />
        <ul role="listbox">
          {matches.length === 0 && <li className="empty">Nothing matches “{query}”.</li>}
          {matches.map((item, i) => {
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <button
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pick(item)}
                >
                  <Icon aria-hidden />
                  {item.label}
                  <span className="group">{item.group}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
