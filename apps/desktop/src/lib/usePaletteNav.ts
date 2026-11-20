import { useEffect, useState, type KeyboardEvent } from "react";

/**
 * Keyboard navigation for a command palette list (R31): one highlighted item, ArrowUp/ArrowDown
 * wrap around, Enter runs the highlight, typing resets it to the first match, the highlight is
 * scrolled into view, and IME composition keys are left alone. Esc stays with the dialog.
 *
 * Spread `inputProps` on the search input (role="combobox"), `optionProps(i)` on each option
 * (role="option"), and give the list element `id={listId}` with role="listbox".
 */
export function usePaletteNav<T extends { run: () => void }>(items: T[], open: boolean, listId = "cmdk-list") {
  const [index, setIndex] = useState(0);
  const active = Math.min(index, Math.max(0, items.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex((active + step + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  };

  return {
    active,
    /** Call when the query changes. */
    reset: () => setIndex(0),
    inputProps: {
      role: "combobox" as const,
      "aria-expanded": true,
      "aria-controls": listId,
      "aria-activedescendant": items[active] ? optionId(active) : undefined,
      onKeyDown,
    },
    optionProps: (i: number) => ({
      id: optionId(i),
      role: "option" as const,
      "aria-selected": i === active,
      tabIndex: -1,
      onMouseMove: () => {
        if (i !== active) setIndex(i);
      },
      onClick: () => items[i]?.run(),
    }),
  };
}
