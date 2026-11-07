// @vitest-environment jsdom
import { createRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { editorView, installEditorTestLayout, replaceEditorText } from "./editorTestUtils";
import type { SqlTable } from "./model";
import type { SqlCompletionMode } from "../settings/model";

installEditorTestLayout();
const tables: SqlTable[] = [
  {
    documentId: "d",
    sessionId: "s",
    fileName: "orders.csv",
    path: "C:/orders.csv",
    alias: "orders",
    columnMode: "name",
    defaultColumnMode: "name",
    nameModeAllowed: true,
    nameModeReason: null,
    columns: [
      {
        id: "s0",
        sourceIndex: 0,
        originalName: 'order "value"',
        sqlType: "BIGINT",
        nullable: false,
      },
    ],
  },
];
function setup(value = "", sourceTables = tables, mode: SqlCompletionMode = "contextual") {
  const ref = createRef<SqlEditorHandle>();
  const onRun = vi.fn();
  function Harness({
    external,
    sources,
    completionMode,
  }: {
    external: string;
    sources: SqlTable[];
    completionMode: SqlCompletionMode;
  }) {
    const [text, setText] = useState(external);
    return (
      <>
        <button onClick={() => setText("SELECT 42")}>Example</button>
        <output aria-label="Current SQL">{text}</output>
        <SqlEditor
          value={text}
          tables={sources}
          completionMode={completionMode}
          onChange={setText}
          onRun={onRun}
          editorRef={ref}
        />
      </>
    );
  }
  const result = render(<Harness external={value} sources={sourceTables} completionMode={mode} />);
  const input = screen.getByRole("textbox", { name: "SQL editor" });
  return {
    ...result,
    input,
    ref,
    onRun,
    view: editorView(input),
    setTables: (sources: SqlTable[]) =>
      result.rerender(<Harness external={value} sources={sources} completionMode={mode} />),
    setMode: (completionMode: SqlCompletionMode) =>
      result.rerender(
        <Harness external={value} sources={sourceTables} completionMode={completionMode} />,
      ),
  };
}

function typeAtCursor(view: ReturnType<typeof editorView>, text: string) {
  for (const character of text)
    act(() => view.dispatch(view.state.replaceSelection(character), { userEvent: "input.type" }));
}
const settleTyping = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
function dotSetup(mode: SqlCompletionMode = "contextual") {
  const result = setup("SELECT o FROM orders o", tables, mode);
  act(() => {
    result.view.focus();
    result.view.dispatch({ selection: { anchor: 8 } });
  });
  typeAtCursor(result.view, ".");
  return result;
}
function joinSources(names: string[]): SqlTable[] {
  const columns = names.map((originalName, sourceIndex) => ({
    ...tables[0].columns[0],
    id: `s${sourceIndex}`,
    originalName,
    sourceIndex,
  }));
  return [
    { ...tables[0], columns },
    {
      ...tables[0],
      documentId: "customers",
      sessionId: "customers-session",
      alias: "customers",
      columns,
    },
  ];
}
describe("CodeMirror SQL editor", () => {
  it("keeps ambiguous generic JOIN candidates manual even alongside a strong key", async () => {
    const { view, input } = setup(
      "SELECT * FROM orders o JOIN customers c ON",
      joinSources(["customer_id", "id"]),
    );
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    typeAtCursor(view, " ");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    await screen.findByText("Inferred, not a verified foreign key.");
    const explanation = screen.getByText("Why this JOIN?").closest("details")!;
    expect(explanation.hasAttribute("open")).toBe(false);
    expect(explanation.textContent).toContain("uniqueness and matching data were not checked");
    expect(document.querySelector(".cm-completionDetail")?.textContent).toBe("Suggested JOIN");
    expect(currentCompletions(view.state).map((item) => item.label)).toEqual([
      "o.customer_id = c.customer_id",
    ]);
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() =>
      expect(currentCompletions(view.state).map((item) => item.label)).toContain("o.id = c.id"),
    );
  });
  it("does not open an empty popup when automatic candidates are all manual-only", async () => {
    const { view, input } = setup(
      "SELECT * FROM orders o JOIN customers c ON ",
      joinSources(["id"]),
      "automatic",
    );
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    typeAtCursor(view, "id");
    await settleTyping();
    expect(completionStatus(view.state)).toBeNull();
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() =>
      expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["o.id = c.id"]),
    );
  });
  it.each(["contextual", "manual"] as const)(
    "keeps ordinary expression typing quiet in %s mode",
    async (mode) => {
      const { view } = setup("SELECT ", tables, mode);
      act(() => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      typeAtCursor(view, "su");
      await settleTyping();
      expect(completionStatus(view.state)).toBeNull();
    },
  );
  it("automatic mode waits for two characters, while explicit completion works immediately", async () => {
    const { view, input } = setup("SELECT ", tables, "automatic");
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    typeAtCursor(view, "s");
    await settleTyping();
    expect(completionStatus(view.state)).toBeNull();
    typeAtCursor(view, "u");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  });
  it("contextual mode automatically offers estimated JOIN ON conditions on direct typing", async () => {
    const sourceTables = [
      { ...tables[0], columns: [{ ...tables[0].columns[0], originalName: "customer_id" }] },
      {
        ...tables[0],
        documentId: "customers",
        sessionId: "customers-session",
        alias: "customers",
        columns: [{ ...tables[0].columns[0], originalName: "customer_id" }],
      },
    ];
    const { view } = setup("SELECT * FROM orders o JOIN customers c ON", sourceTables);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    typeAtCursor(view, " ");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  });
  it.each(["SELECT * FROM", "SELECT * FROM orders o LEFT JOIN", "SELECT * FROM orders o,"])(
    "automatically suggests tables after %s in contextual mode",
    async (sql) => {
      const { view, input, onRun } = setup(sql);
      act(() => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      typeAtCursor(view, " ");
      await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
      expect(currentCompletions(view.state).map(({ label }) => label)).toEqual(["orders"]);
      fireEvent.keyDown(input, { key: "Tab" });
      expect(view.state.doc.toString()).toBe(sql + " orders");
      expect(onRun).not.toHaveBeenCalled();
    },
  );
  it("manual mode keeps a JOIN table token quiet until explicit completion", async () => {
    const { view, input } = setup("SELECT * FROM orders o JOIN ", tables, "manual");
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    typeAtCursor(view, "ord");
    await settleTyping();
    expect(completionStatus(view.state)).toBeNull();
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  });
  it("manual mode suppresses automatic dot completion but allows Ctrl+Space", async () => {
    const { view, input } = dotSetup("manual");
    await settleTyping();
    expect(completionStatus(view.state)).toBeNull();
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  });
  it("accepts an automatic dot suggestion with initial Enter", async () => {
    const { view, input } = dotSetup();
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.state.doc.toString()).toBe('SELECT o."order ""value""" FROM orders o');
  });
  it.each(["SELECT *", "FROM orders", "JOIN customers c ON", "WHERE id = 1"])(
    "does not add SQL continuation indentation after %s",
    (sql) => {
      const { view, input, onRun } = setup(sql);
      act(() => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(view.state.doc.toString()).toBe(sql + "\n");
      expect(onRun).not.toHaveBeenCalled();
      act(() => {
        undo(view);
      });
      expect(view.state.doc.toString()).toBe(sql);
    },
  );
  it.each(["  ", "\t"])("keeps existing manual indent %j without adding more", (indent) => {
    const sql = indent + "SELECT *";
    const { view, input } = setup(sql);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.state.doc.toString()).toBe(sql + "\n" + indent);
    typeAtCursor(view, "FROM orders");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.state.doc.toString()).toBe(sql + "\n" + indent + "FROM orders\n" + indent);
  });
  it("Shift+Enter breaks a line instead of accepting an explicitly opened completion", async () => {
    const { view, input } = setup("SELECT * FROM ord");
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(view.state.doc.toString()).toBe("SELECT * FROM ord\n");
  });
  it.each(["Tab", "ArrowDown", "ArrowUp", "PageDown", "PageUp"])(
    "accepts automatic dot suggestions with deliberate %s selection",
    async (key) => {
      const { view, input } = dotSetup();
      await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
      if (key === "PageDown" || key === "PageUp") {
        // JSDOM has no layout; CodeMirror derives its page step from rendered row heights.
        const popup = document.querySelector<HTMLElement>(".cm-tooltip-autocomplete")!;
        Object.defineProperty(popup, "offsetHeight", { value: 120 });
        Object.defineProperty(popup.querySelector("li")!, "offsetHeight", { value: 20 });
      }
      fireEvent.keyDown(input, { key });
      if (key !== "Tab") fireEvent.keyDown(input, { key: "Enter" });
      expect(view.state.doc.toString()).toBe('SELECT o."order ""value""" FROM orders o');
    },
  );
  it("Escape suppresses the same token until explicit completion or a new dot token", async () => {
    const { view, input } = dotSetup();
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Escape" });
    typeAtCursor(view, "or");
    await settleTyping();
    expect(completionStatus(view.state)).toBeNull();
    fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Escape" });
    typeAtCursor(view, " o.");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  });
  it("changing mode invalidates a visible popup without rewriting SQL", async () => {
    const { view, setMode } = dotSetup();
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    const before = view.state.doc.toString();
    setMode("manual");
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe(before);
  });
  it("shows the curated function signature and one-based argument position", async () => {
    const { view, input } = setup();
    replaceEditorText(input, "SELECT COALESCE(SUM(1), ");
    act(() => view.focus());
    const hint = await screen.findByRole("tooltip", { name: "SQL function signature" });
    expect(hint).toHaveTextContent("COALESCE(value, fallback, …)");
    expect(hint).toHaveTextContent("Argument 2");
  });
  it.each(["Enter", "Tab"])("accepts a quoted table using %s without running SQL", async (key) => {
    const { view, input, onRun } = setup("SELECT * FROM ord");
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    act(() => startCompletion(view));
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key });
    expect(view.state.doc.toString()).toBe("SELECT * FROM orders");
    expect(onRun).not.toHaveBeenCalled();
  });
  it("dismisses completion using Escape without changing SQL", async () => {
    const { view, input } = setup("SELECT * FROM ord");
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    act(() => startCompletion(view));
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe("SELECT * FROM ord");
  });
  it("keeps selection-aware sidebar inserts and external examples in undo history", () => {
    const { view, ref, input } = setup("SELECT old");
    act(() => view.dispatch({ selection: { anchor: 7, head: 10 } }));
    act(() => ref.current!.insertText('"new value"'));
    expect(view.state.doc.toString()).toBe('SELECT "new value"');
    expect(document.activeElement).toBe(input);
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe("SELECT old");
    fireEvent.click(screen.getByRole("button", { name: "Example" }));
    expect(view.state.doc.toString()).toBe("SELECT 42");
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe("SELECT old");
  });
  it("runs Ctrl+Enter once and does not run or accept during composition", async () => {
    const { input, onRun, view } = setup("SELECT ");
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    act(() => startCompletion(view));
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onRun).toHaveBeenCalledOnce();
    const before = view.state.doc.toString();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Tab", isComposing: true });
    expect(onRun).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe(before);
  });
  it("closes stale suggestions when metadata changes without replacing SQL or undo", async () => {
    const { view, input, setTables } = setup("SELECT * FROM ord");
    replaceEditorText(input, "SELECT * FROM ord");
    act(() => startCompletion(view));
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    setTables([{ ...tables[0], alias: "renamed", columnMode: "ordinal" }]);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe("SELECT * FROM ord");
    act(() => startCompletion(view));
    await waitFor(() => expect(completionStatus(view.state)).not.toBe("pending"));
    expect(screen.queryByRole("option", { name: /orders/ })).not.toBeInTheDocument();
  });
  it("opens local search without changing SQL or running a query", () => {
    const { view, input, onRun } = setup("SELECT 1");
    fireEvent.keyDown(input, { key: "f", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Find" })).toBeInTheDocument();
    expect(view.state.doc.toString()).toBe("SELECT 1");
    expect(onRun).not.toHaveBeenCalled();
  });
});
