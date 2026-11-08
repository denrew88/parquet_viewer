import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";

export const QUERY_SEPARATOR_PX = 7;

export function clampQueryPane(totalHeight: number, preferred: number | null) {
  const available = Math.max(
    0,
    Math.floor(Number.isFinite(totalHeight) ? totalHeight : 0) - QUERY_SEPARATOR_PX,
  );
  const compact = available < 485;
  const minimumQuery = compact ? 125 : 140;
  const minimumOutput = compact ? 252 : 280;
  const fits = available >= minimumQuery + minimumOutput;
  const min = fits ? minimumQuery : Math.floor(available * 0.4);
  const max = fits ? available - minimumOutput : min;
  const defaultTop = compact ? available * 0.37 : Math.max(205, Math.min(320, available * 0.4));
  const requested = preferred !== null && Number.isFinite(preferred) ? preferred : defaultTop;
  return { min, max, top: Math.max(min, Math.min(max, Math.round(requested))) };
}

export function useVerticalSplitter<T extends HTMLElement>(
  active: boolean,
  clamp: (height: number, preferred: number | null) => { min: number; max: number; top: number },
) {
  const pane = useRef<T>(null);
  const [height, setHeight] = useState(0);
  const [preferred, setPreferred] = useState<number | null>(null);
  const measuredHeight = useRef(height);
  const drag = useRef<{
    pointerId: number;
    startY: number;
    startTop: number;
    previous: number | null;
    element: HTMLElement;
  } | null>(null);
  const split = clamp(height, preferred);
  const finish = useCallback((revert: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (revert) setPreferred(current.previous);
    if (current.element.hasPointerCapture?.(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
  }, []);

  useLayoutEffect(() => {
    if (!active) {
      finish(true);
      return;
    }
    const measure = () => {
      const next = pane.current?.getBoundingClientRect().height ?? 0;
      if (next > 0) {
        measuredHeight.current = next;
        setHeight(next);
      }
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (pane.current) observer?.observe(pane.current);
    window.addEventListener("resize", measure);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", escape, true);
    };
  }, [active, finish]);

  const separator: HTMLAttributes<HTMLDivElement> = {
    role: "separator",
    "aria-orientation": "horizontal",
    tabIndex: 0,
    "aria-valuemin": split.min,
    "aria-valuemax": split.max,
    "aria-valuenow": split.top,
    onPointerDown(event) {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startTop: split.top,
        previous: preferred,
        element: event.currentTarget,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      const current = drag.current;
      if (current?.pointerId === event.pointerId)
        setPreferred(
          clamp(measuredHeight.current, current.startTop + event.clientY - current.startY).top,
        );
    },
    onPointerUp(event) {
      if (drag.current?.pointerId === event.pointerId) finish(false);
    },
    onPointerCancel(event) {
      if (drag.current?.pointerId === event.pointerId) finish(true);
    },
    onLostPointerCapture() {
      finish(true);
    },
    onDoubleClick() {
      finish(false);
      setPreferred(null);
    },
    onKeyDown(event) {
      const positions: Record<string, number> = {
        ArrowUp: split.top - 10,
        ArrowDown: split.top + 10,
        Home: split.min,
        End: split.max,
      };
      if (!Object.prototype.hasOwnProperty.call(positions, event.key)) return;
      event.preventDefault();
      setPreferred(clamp(height, positions[event.key]).top);
    },
  };
  return { pane, height, top: split.top, separator };
}
