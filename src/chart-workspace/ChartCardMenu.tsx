import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  x: number;
  y: number;
  duplicateDisabled: boolean;
  onSettings(): void;
  onDuplicate(): void;
  onDelete(): void;
  onClose(restoreFocus: boolean): void;
}

export function ChartCardMenu({
  x,
  y,
  duplicateDisabled,
  onSettings,
  onDuplicate,
  onDelete,
  onClose,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = element.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - bounds.height - 8)),
    });
    menu.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) onClose(false);
    };
    const resized = () => onClose(true);
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", resized);
    };
  }, [x, y, onClose]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      element.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    let target: number;
    if (event.key === "ArrowDown") target = (current + 1) % items.length;
    else if (event.key === "ArrowUp") target = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = items.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    items[target]?.focus();
  }

  return (
    <div
      ref={element}
      role="menu"
      aria-label="Chart actions"
      className="chart-card-menu"
      style={position}
      onKeyDown={navigate}
      onContextMenu={(event) => event.preventDefault()}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          onClose(false);
      }}
    >
      <button type="button" role="menuitem" onClick={onSettings}>
        Chart Settings
      </button>
      <button type="button" role="menuitem" disabled={duplicateDisabled} onClick={onDuplicate}>
        Duplicate Chart
      </button>
      <button type="button" role="menuitem" className="chart-menu-delete" onClick={onDelete}>
        Delete Chart
      </button>
    </div>
  );
}
