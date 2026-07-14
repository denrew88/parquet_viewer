import {
  getCurrentWebview,
  type DragDropEvent as TauriDragDropEvent,
} from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type FileDragDropEvent = TauriDragDropEvent;
export type FileDragDropHandler = (event: FileDragDropEvent) => void;

export interface DragDropAdapter {
  onDragDropEvent(handler: FileDragDropHandler): Promise<UnlistenFn>;
}

export const tauriDragDropAdapter: DragDropAdapter = {
  async onDragDropEvent(handler) {
    return getCurrentWebview().onDragDropEvent((event) => handler(event.payload));
  },
};

const browserHandlers = new Set<FileDragDropHandler>();

export const browserDragDropAdapter: DragDropAdapter = {
  async onDragDropEvent(handler) {
    browserHandlers.add(handler);
    return () => browserHandlers.delete(handler);
  },
};

export function emitBrowserDragDropEvent(event: FileDragDropEvent): void {
  browserHandlers.forEach((handler) => handler(event));
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createDefaultDragDropAdapter(): DragDropAdapter {
  return isTauriRuntime() ? tauriDragDropAdapter : browserDragDropAdapter;
}
