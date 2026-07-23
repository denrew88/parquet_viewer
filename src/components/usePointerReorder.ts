import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const DRAG_THRESHOLD = 6;
const EDGE_SIZE = 32;
const EDGE_STEP = 24;

let activePointerReorderCount = 0;

export function isInternalPointerReorderActive(): boolean {
  return activePointerReorderCount > 0;
}

function setInternalPointerReorderActive(active: boolean): void {
  activePointerReorderCount = Math.max(0, activePointerReorderCount + (active ? 1 : -1));
}

export function reorderAtInsertion(
  ids: readonly string[],
  movingId: string,
  targetId: string,
  side: "before" | "after",
): string[] {
  if (movingId === targetId || !ids.includes(movingId) || !ids.includes(targetId)) return [...ids];
  const next = ids.filter((id) => id !== movingId);
  let index = next.indexOf(targetId);
  if (side === "after") index += 1;
  next.splice(index, 0, movingId);
  return next;
}

interface DragSession {
  pointerId: number;
  movingId: string;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  dragging: boolean;
  targetId: string | null;
  side: "before" | "after";
  element: HTMLElement;
  sourceRect: PointerReorderRect;
}

function insertionAtPointer(
  container: HTMLElement,
  orientation: "horizontal" | "vertical",
  session: DragSession,
): { targetId: string | null; side: "before" | "after" } {
  const axis = orientation === "horizontal" ? session.clientX : session.clientY;
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>("[data-reorder-id]"),
  ).filter((element) => element.dataset.reorderId !== session.movingId);
  let target: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    const start = orientation === "horizontal" ? rect.left : rect.top;
    const end = orientation === "horizontal" ? rect.right : rect.bottom;
    const distance = axis < start ? start - axis : axis > end ? axis - end : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      target = candidate;
    }
  }
  if (!target) return { targetId: null, side: "before" };
  const rect = target.getBoundingClientRect();
  const midpoint =
    orientation === "horizontal" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  return {
    targetId: target.dataset.reorderId ?? null,
    side: axis < midpoint ? "before" : "after",
  };
}

export interface PointerReorderState {
  movingId: string | null;
  targetId: string | null;
  side: "before" | "after" | null;
  clientX: number | null;
  clientY: number | null;
  grabOffsetX: number | null;
  grabOffsetY: number | null;
  sourceRect: PointerReorderRect | null;
}

export interface PointerReorderRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const idleState: PointerReorderState = {
  movingId: null,
  targetId: null,
  side: null,
  clientX: null,
  clientY: null,
  grabOffsetX: null,
  grabOffsetY: null,
  sourceRect: null,
};

export interface UsePointerReorderOptions {
  ids: readonly string[];
  containerRef: RefObject<HTMLElement | null>;
  orientation: "horizontal" | "vertical";
  onCommit(ids: string[]): void;
}

export function usePointerReorder({
  ids,
  containerRef,
  orientation,
  onCommit,
}: UsePointerReorderOptions) {
  const sessionRef = useRef<DragSession | null>(null);
  const suppressedClickId = useRef<string | null>(null);
  const edgeScrollFrame = useRef<number | null>(null);
  const edgeScroll = useRef<{ container: HTMLElement; direction: -1 | 1 } | null>(null);
  const [state, setState] = useState<PointerReorderState>(idleState);

  const stopEdgeScroll = useCallback(() => {
    edgeScroll.current = null;
    if (edgeScrollFrame.current !== null) {
      window.cancelAnimationFrame(edgeScrollFrame.current);
      edgeScrollFrame.current = null;
    }
  }, []);

  const updateTarget = useCallback(
    (container: HTMLElement, session: DragSession) => {
      const insertion = insertionAtPointer(container, orientation, session);
      session.targetId = insertion.targetId;
      session.side = insertion.side;
      setState({
        movingId: session.movingId,
        targetId: insertion.targetId,
        side: insertion.side,
        clientX: session.clientX,
        clientY: session.clientY,
        grabOffsetX: session.startX - session.sourceRect.left,
        grabOffsetY: session.startY - session.sourceRect.top,
        sourceRect: session.sourceRect,
      });
    },
    [orientation],
  );

  const startEdgeScroll = useCallback(
    (container: HTMLElement, direction: -1 | 1) => {
      edgeScroll.current = { container, direction };
      if (edgeScrollFrame.current !== null) return;
      const tick = () => {
        const request = edgeScroll.current;
        const session = sessionRef.current;
        if (!request || !session?.dragging) {
          edgeScrollFrame.current = null;
          return;
        }
        const before =
          orientation === "horizontal" ? request.container.scrollLeft : request.container.scrollTop;
        if (orientation === "horizontal") {
          request.container.scrollLeft += request.direction * EDGE_STEP;
        } else {
          request.container.scrollTop += request.direction * EDGE_STEP;
        }
        const after =
          orientation === "horizontal" ? request.container.scrollLeft : request.container.scrollTop;
        updateTarget(request.container, session);
        if (after === before) {
          edgeScroll.current = null;
          edgeScrollFrame.current = null;
          return;
        }
        edgeScrollFrame.current = window.requestAnimationFrame(tick);
      };
      edgeScrollFrame.current = window.requestAnimationFrame(tick);
    },
    [orientation, updateTarget],
  );

  const finish = useCallback(
    (pointerId: number, commit: boolean) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      sessionRef.current = null;
      stopEdgeScroll();
      if (session.element.hasPointerCapture(pointerId))
        session.element.releasePointerCapture(pointerId);
      if (session.dragging) {
        setInternalPointerReorderActive(false);
        if (commit) suppressedClickId.current = session.movingId;
        if (commit && session.targetId) {
          onCommit(reorderAtInsertion(ids, session.movingId, session.targetId, session.side));
        }
      }
      setState(idleState);
    },
    [ids, onCommit, stopEdgeScroll],
  );
  const latestFinish = useRef(finish);
  latestFinish.current = finish;

  useEffect(() => {
    const cancel = (event: KeyboardEvent | Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      const session = sessionRef.current;
      if (!session?.dragging) return;
      event.preventDefault();
      sessionRef.current = null;
      stopEdgeScroll();
      if (session.element.hasPointerCapture(session.pointerId)) {
        session.element.releasePointerCapture(session.pointerId);
      }
      setInternalPointerReorderActive(false);
      setState(idleState);
    };
    const finishFromWindow = (event: PointerEvent) =>
      latestFinish.current(event.pointerId, event.type === "pointerup");
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerup", finishFromWindow);
    window.addEventListener("pointercancel", finishFromWindow);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerup", finishFromWindow);
      window.removeEventListener("pointercancel", finishFromWindow);
      stopEdgeScroll();
      if (sessionRef.current?.dragging) setInternalPointerReorderActive(false);
      sessionRef.current = null;
    };
  }, [stopEdgeScroll]);

  const getItemProps = useCallback(
    (id: string) => ({
      "data-reorder-id": id,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || event.isPrimary === false) return;
        const interactive = (event.target as Element).closest(
          "button, input, select, textarea, [data-reorder-ignore]",
        );
        if (interactive && interactive !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        sessionRef.current = {
          pointerId: event.pointerId,
          movingId: id,
          startX: event.clientX,
          startY: event.clientY,
          clientX: event.clientX,
          clientY: event.clientY,
          dragging: false,
          targetId: null,
          side: "before",
          element: event.currentTarget,
          sourceRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        session.clientX = event.clientX;
        session.clientY = event.clientY;
        if (!session.dragging) {
          const distance = Math.hypot(
            event.clientX - session.startX,
            event.clientY - session.startY,
          );
          if (distance < DRAG_THRESHOLD) return;
          session.dragging = true;
          setInternalPointerReorderActive(true);
        }
        event.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        let edgeDirection: -1 | 1 | null = null;
        if (orientation === "horizontal") {
          if (event.clientX < containerRect.left + EDGE_SIZE) edgeDirection = -1;
          else if (event.clientX > containerRect.right - EDGE_SIZE) edgeDirection = 1;
        } else {
          if (event.clientY < containerRect.top + EDGE_SIZE) edgeDirection = -1;
          else if (event.clientY > containerRect.bottom - EDGE_SIZE) edgeDirection = 1;
        }
        if (edgeDirection === null) stopEdgeScroll();
        else startEdgeScroll(container, edgeDirection);
        updateTarget(container, session);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event.pointerId, true),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event.pointerId, false),
      onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => {
        if (sessionRef.current?.pointerId === event.pointerId) finish(event.pointerId, false);
      },
    }),
    [containerRef, finish, orientation, startEdgeScroll, stopEdgeScroll, updateTarget],
  );

  const consumeSuppressedClick = useCallback((id: string) => {
    if (suppressedClickId.current !== id) return false;
    suppressedClickId.current = null;
    return true;
  }, []);

  return { state, getItemProps, consumeSuppressedClick };
}
