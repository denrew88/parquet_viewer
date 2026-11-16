import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import {
  defaultSqlPanePreference,
  readSqlPanePreference,
  saveSqlPanePreference,
  SQL_PANE_SEPARATOR,
  sqlPaneGeometry,
  type SqlPanePreference,
} from "./sqlPaneLayout";

export function useSqlPaneLayout(active: boolean, sourceOpen: boolean) {
  const pane = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [preference, setPreference] = useState(readSqlPanePreference);
  const latest = useRef(preference);
  latest.current = preference;
  const drag = useRef<{
    pointerId: number;
    kind: "tables" | "source";
    horizontal: boolean;
    start: number;
    value: number;
    before: SqlPanePreference;
    element: HTMLDivElement;
  } | null>(null);
  const geometry = sqlPaneGeometry(size.width, size.height, preference, sourceOpen);
  const update = useCallback((next: SqlPanePreference, persist = true) => {
    latest.current = next;
    setPreference(next);
    if (persist) saveSqlPanePreference(next);
  }, []);
  const finish = useCallback(
    (cancel: boolean) => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      if (cancel) update(current.before, false);
      else saveSqlPanePreference(latest.current);
      if (current.element.hasPointerCapture?.(current.pointerId))
        current.element.releasePointerCapture(current.pointerId);
    },
    [update],
  );
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const rect = pane.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0)
        setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (pane.current) observer?.observe(pane.current);
    window.addEventListener("resize", measure);
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener("keydown", cancel, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", cancel, true);
      if (drag.current) finish(true);
    };
  }, [active, finish]);

  function separator(kind: "tables" | "source"): HTMLAttributes<HTMLDivElement> {
    const horizontal = kind === "source" && geometry.dock === "bottom";
    const value =
      kind === "tables" ? geometry.tables : horizontal ? geometry.sourceHeight : geometry.source;
    const min =
      kind === "tables"
        ? geometry.minTables
        : horizontal
          ? geometry.minSourceHeight
          : geometry.minSource;
    const max =
      kind === "tables"
        ? geometry.tablesMax
        : horizontal
          ? geometry.sourceHeightMax
          : geometry.sourceMax;
    function resize(pixels: number, persist: boolean) {
      const clamped = Math.max(min, Math.min(max, pixels));
      update(
        {
          ...latest.current,
          [kind === "tables" ? "tables" : horizontal ? "sourceHeight" : "source"]:
            clamped / Math.max(1, horizontal ? size.height - SQL_PANE_SEPARATOR : size.width),
        },
        persist,
      );
    }
    return {
      role: "separator",
      tabIndex: 0,
      "aria-label": kind === "tables" ? "Resize SQL tables pane" : "Resize SQL source pane",
      "aria-orientation": horizontal ? "horizontal" : "vertical",
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": value,
      onPointerDown(event) {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = {
          pointerId: event.pointerId,
          kind,
          horizontal,
          start: horizontal ? event.clientY : event.clientX,
          value,
          before: latest.current,
          element: event.currentTarget,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove(event) {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const delta = (horizontal ? event.clientY : event.clientX) - current.start;
        resize(current.value + (kind === "tables" ? delta : -delta), false);
      },
      onPointerUp(event) {
        if (drag.current?.pointerId === event.pointerId) finish(false);
      },
      onPointerCancel() {
        finish(true);
      },
      onLostPointerCapture() {
        finish(true);
      },
      onDoubleClick() {
        finish(false);
        update({
          ...latest.current,
          [kind === "tables" ? "tables" : horizontal ? "sourceHeight" : "source"]:
            defaultSqlPanePreference[
              kind === "tables" ? "tables" : horizontal ? "sourceHeight" : "source"
            ],
        });
      },
      onKeyDown(event) {
        const decrease = horizontal ? "ArrowDown" : kind === "tables" ? "ArrowLeft" : "ArrowRight";
        const increase = horizontal ? "ArrowUp" : kind === "tables" ? "ArrowRight" : "ArrowLeft";
        if (![decrease, increase, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        resize(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : value + (event.key === increase ? 10 : -10),
          true,
        );
      },
    };
  }
  const style: CSSProperties | undefined =
    size.width > 0
      ? sourceOpen && geometry.dock === "right"
        ? {
            gridTemplateColumns: `${geometry.tables}px ${SQL_PANE_SEPARATOR}px minmax(0,1fr) ${SQL_PANE_SEPARATOR}px ${geometry.source}px`,
          }
        : {
            gridTemplateColumns: `${geometry.tables}px ${SQL_PANE_SEPARATOR}px minmax(0,1fr)`,
            ...(sourceOpen
              ? {
                  gridTemplateRows: `minmax(0,1fr) ${SQL_PANE_SEPARATOR}px ${geometry.sourceHeight}px`,
                }
              : {}),
          }
      : undefined;
  return {
    pane,
    style,
    dock: geometry.dock,
    tablesSeparator: separator("tables"),
    sourceSeparator: separator("source"),
    toggleDock: () =>
      update({ ...latest.current, dock: geometry.dock === "right" ? "bottom" : "right" }),
  };
}
