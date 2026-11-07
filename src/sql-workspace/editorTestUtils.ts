import { EditorView } from "@codemirror/view";
import { act } from "@testing-library/react";

// JSDOM has no text layout. Browser E2E owns visual and geometry assertions.
export function installEditorTestLayout() {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
export function editorView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error("SQL editor view is not mounted");
  return view;
}
export function replaceEditorText(element: HTMLElement, text: string) {
  const view = editorView(element);
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    }),
  );
}
