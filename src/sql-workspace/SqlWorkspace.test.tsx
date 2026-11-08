// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { SqlWorkspace } from "./SqlWorkspace";
import { browserMockBackend, type BackendAdapter, type DataPage } from "../backend";
import { defaultAppSettings } from "../settings/model";
import type { SqlStatus, SqlTableDescriptor, SqlWorkspaceBackend } from "./backend";
import type { VirtualDataGridProps } from "../VirtualDataGrid";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { editorView, installEditorTestLayout, replaceEditorText } from "./editorTestUtils";
import { SQL_HELP_PREFERENCE_KEY } from "./workspaceState";

installEditorTestLayout();
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 42,
    getVirtualItems: () =>
      Array.from({ length: Math.min(8, options.count) }, (_, index) => ({
        index,
        key: index,
        size: 42,
        start: index * 42,
      })),
  }),
}));
vi.mock("../VirtualDataGrid", () => ({
  VirtualDataGrid: (props: VirtualDataGridProps) => (
    <div data-testid="sql-test-grid" data-result={props.summary.sessionId}>
      {props.summary.columns.map((column) => (
        <span key={column.name}>{props.columnLabels?.[column.name] ?? column.name}</span>
      ))}
      {props.page.rows.map((row, i) => (
        <span key={i}>{row[0].display}</span>
      ))}
    </div>
  ),
}));

const descriptors: SqlTableDescriptor[] = [
  {
    documentId: "d1",
    sessionId: "s1",
    fileName: "orders.csv",
    path: "C:/orders.csv",
    defaultColumnMode: "name",
    nameModeAllowed: true,
    nameModeReason: null,
    columns: [
      {
        id: "s0",
        sourceIndex: 0,
        originalName: '商品 "名前"',
        sqlType: "VARCHAR",
        nullable: false,
      },
      { id: "s37", sourceIndex: 37, originalName: "tail", sqlType: "BIGINT", nullable: false },
    ],
  },
  {
    documentId: "d2",
    sessionId: "s2",
    fileName: "orders.csv",
    path: "D:/orders.csv",
    defaultColumnMode: "ordinal",
    nameModeAllowed: false,
    nameModeReason: "Duplicate original name",
    columns: [
      { id: "s0", sourceIndex: 0, originalName: "same", sqlType: "VARCHAR", nullable: false },
      { id: "s1", sourceIndex: 1, originalName: "same", sqlType: "VARCHAR", nullable: false },
    ],
  },
];
const sources = descriptors.map(({ documentId, sessionId }) => ({ documentId, sessionId }));
const ready = (runId: string): SqlStatus => ({
  runId,
  state: "complete",
  phase: "complete",
  elapsedMs: 1,
  rowsProduced: 1,
  resultId: `${runId}-result`,
  columns: [
    { id: "r0", name: "duplicate", logicalType: "VARCHAR", nullable: false },
    { id: "r1", name: "duplicate", logicalType: "BIGINT", nullable: false },
  ],
  rowCount: 1,
  planText: null,
  planJson: null,
  warnings: [],
  error: null,
});
const page = (sessionId: string, display = "retained"): DataPage => ({
  sessionId,
  offset: 0,
  limit: 100,
  totalRows: 1,
  hasMore: false,
  columns: ["r0", "r1"],
  rows: [
    [
      { kind: "string", display },
      { kind: "int", display: "1" },
    ],
  ],
});
function setup(overrides: Partial<SqlWorkspaceBackend> = {}) {
  const api: SqlWorkspaceBackend = {
    describeTables: vi.fn(async () => descriptors),
    startQuery: vi.fn(async (request) => ready(request.runId)),
    getStatus: vi.fn(async (runId) => ready(runId)),
    cancelQuery: vi.fn(async (runId) => ({
      ...ready(runId),
      state: "cancelled" as const,
      resultId: null,
      columns: [],
      rowCount: null,
    })),
    readPage: vi.fn(async (request) => page(request.resultId)),
    readCell: vi.fn(async () => ({ kind: "string" as const, display: "full" })),
    releaseResult: vi.fn(async () => {}),
    startCopy: vi.fn(),
    exportResult: vi.fn(),
    ...overrides,
  };
  const backend: BackendAdapter = { ...browserMockBackend, sqlWorkspace: api };
  const props = {
    active: true,
    backend,
    sources,
    settings: defaultAppSettings(),
    onOpenCopySettings: vi.fn(),
    onOpenSource: vi.fn(),
  };
  const view = render(<SqlWorkspace {...props} />);
  return { ...view, api, props };
}
describe("SQL workspace", () => {
  it("resizes source panes with keyboard, clamping after viewport changes and reactivation", async () => {
    let height = 476;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("sql-sources")
        ? new DOMRect(0, 0, 246, height)
        : original.call(this);
    });
    const { rerender, props } = setup();
    await screen.findByRole("button", { name: "orders" });
    const separator = screen.getByRole("separator", { name: "Resize tables and columns" });
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator).toHaveAttribute("aria-valuemin", "160");
    expect(separator).toHaveAttribute("aria-valuemax", "289");
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator).toHaveAttribute("aria-valuenow", "170");
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(separator).toHaveAttribute("aria-valuenow", "160");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "289");
    height = 400;
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuenow", "213");
    rerender(<SqlWorkspace {...props} active={false} />);
    height = 776;
    rerender(<SqlWorkspace {...props} />);
    expect(separator).toHaveAttribute("aria-valuenow", "289");
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "246");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "160");
  });
  it("captures pointer resizing and restores the pre-drag height on cancellation or Escape", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("sql-sources")
        ? new DOMRect(0, 0, 246, 476)
        : original.call(this);
    });
    setup();
    await screen.findByRole("button", { name: "orders" });
    const separator = screen.getByRole("separator", { name: "Resize tables and columns" });
    const capture = vi.fn(),
      release = vi.fn();
    separator.setPointerCapture = capture;
    separator.hasPointerCapture = () => true;
    separator.releasePointerCapture = release;
    function pointer(type: string, y: number) {
      const event = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 7 });
      fireEvent(separator, event);
    }
    pointer("pointerdown", 160);
    pointer("pointermove", 220);
    expect(capture).toHaveBeenCalledWith(7);
    expect(separator).toHaveAttribute("aria-valuenow", "220");
    pointer("pointercancel", 220);
    expect(separator).toHaveAttribute("aria-valuenow", "160");
    pointer("pointerdown", 160);
    pointer("pointermove", 1000);
    expect(separator).toHaveAttribute("aria-valuenow", "289");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(separator).toHaveAttribute("aria-valuenow", "160");
    pointer("pointerdown", 160);
    pointer("pointermove", 190);
    pointer("pointerup", 190);
    expect(separator).toHaveAttribute("aria-valuenow", "190");
    expect(release).toHaveBeenCalledWith(7);
    expect(screen.getByRole("button", { name: "orders" })).toHaveAttribute("aria-pressed", "true");
  });
  it("tracks exact SQL and reversible table setup changes against the submitted result", async () => {
    setup();
    await screen.findByRole("button", { name: "orders" });
    const editor = screen.getByRole("textbox", { name: "SQL editor" });
    replaceEditorText(editor, "SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const context = await screen.findByRole("status", { name: "Result context" });
    expect(context).toHaveAttribute("data-current", "true");
    replaceEditorText(editor, "SELECT 1 ");
    expect(context).toHaveTextContent("SQL changed · previous result");
    replaceEditorText(editor, "SELECT 1");
    expect(context).toHaveAttribute("data-current", "true");
    fireEvent.click(screen.getByRole("radio", { name: /c-numbers only/ }));
    expect(context).toHaveTextContent("Table setup changed · previous result");
    fireEvent.click(screen.getByRole("radio", { name: /Original names only/ }));
    expect(context).toHaveAttribute("data-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Rename table orders" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Table alias" }), {
      target: { value: "changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save table alias" }));
    expect(context).toHaveAttribute("data-current", "false");
    fireEvent.click(screen.getByRole("button", { name: "Rename table changed" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Table alias" }), {
      target: { value: "orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save table alias" }));
    expect(context).toHaveAttribute("data-current", "true");
  });
  it.each(["execute", "explain"] as const)(
    "captures submitted SQL while %s is awaiting completion",
    async (action) => {
      let finish!: (status: SqlStatus) => void;
      const { api } = setup({
        startQuery: vi.fn(
          () =>
            new Promise<SqlStatus>((resolve) => {
              finish = resolve;
            }),
        ),
      });
      await screen.findByRole("button", { name: "orders" });
      const editor = screen.getByRole("textbox", { name: "SQL editor" });
      replaceEditorText(editor, "SELECT 1");
      fireEvent.click(
        screen.getByRole("button", { name: action === "execute" ? "Run" : "Explain" }),
      );
      const runId = vi.mocked(api.startQuery).mock.calls[0][0].runId;
      replaceEditorText(editor, "SELECT 2");
      await act(async () =>
        finish(
          action === "execute"
            ? ready(runId)
            : { ...ready(runId), resultId: null, columns: [], rowCount: null, planText: "Plan A" },
        ),
      );
      const context = await screen.findByRole("status", {
        name: action === "execute" ? "Result context" : "Plan context",
      });
      expect(context).toHaveTextContent(
        `SQL changed · previous ${action === "execute" ? "result" : "plan"}`,
      );
      expect(editorView(editor).state.doc.toString()).toBe("SELECT 2");
      replaceEditorText(editor, "SELECT 1");
      expect(context).toHaveAttribute("data-current", "true");
    },
  );
  it("reveals a first-page failure from the plan tab, preserving the previous result and retry provenance", async () => {
    const readPage = vi
      .fn<SqlWorkspaceBackend["readPage"]>()
      .mockImplementationOnce(async (request) => page(request.resultId))
      .mockRejectedValueOnce(new Error("Page unavailable"))
      .mockImplementation(async (request) => page(request.resultId));
    const { api } = setup({
      readPage,
      startQuery: vi.fn<SqlWorkspaceBackend["startQuery"]>(async (request) =>
        request.action === "execute"
          ? ready(request.runId)
          : {
              ...ready(request.runId),
              resultId: null,
              columns: [],
              rowCount: null,
              planText: "Plan A",
            },
      ),
    });
    await screen.findByRole("button", { name: "orders" });
    const editor = screen.getByRole("textbox", { name: "SQL editor" });
    replaceEditorText(editor, "SELECT 0");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const previous = (await screen.findByTestId("sql-test-grid")).getAttribute("data-result");
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await screen.findByRole("status", { name: "Plan context" });
    expect(screen.getByRole("tab", { name: "Execution plan" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    replaceEditorText(editor, "SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Page unavailable");
    expect(screen.getByRole("tab", { name: "Results" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Retry result page" })).toBeVisible();
    expect(screen.getByTestId("sql-test-grid")).toHaveAttribute("data-result", previous);
    replaceEditorText(editor, "SELECT 2");
    fireEvent.click(screen.getByRole("button", { name: "Retry result page" }));
    await waitFor(() =>
      expect(screen.getByTestId("sql-test-grid")).not.toHaveAttribute("data-result", previous),
    );
    const context = await screen.findByRole("status", { name: "Result context" });
    expect(context).toHaveTextContent("SQL changed · previous result");
    expect(api.startQuery).toHaveBeenCalledTimes(3);
    expect(readPage.mock.calls[1][0]).toEqual(readPage.mock.calls[2][0]);
    replaceEditorText(editor, "SELECT 1");
    expect(context).toHaveAttribute("data-current", "true");
  });
  it("ignores a late retry rejection after a newer result has been published", async () => {
    let rejectRetry!: (error: Error) => void;
    const retry = new Promise<DataPage>((_resolve, reject) => {
      rejectRetry = reject;
    });
    const readPage = vi
      .fn<SqlWorkspaceBackend["readPage"]>()
      .mockRejectedValueOnce(new Error("First page failed"))
      .mockImplementationOnce(() => retry)
      .mockImplementation(async (request) => page(request.resultId, "new result"));
    const { api } = setup({ readPage });
    await screen.findByRole("button", { name: "orders" });
    const editor = screen.getByRole("textbox", { name: "SQL editor" });
    replaceEditorText(editor, "SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("First page failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry result page" }));
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
    replaceEditorText(editor, "SELECT 2");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("new result");
    const result = screen.getByTestId("sql-test-grid").getAttribute("data-result");
    await act(async () => rejectRetry(new Error("Late retry failed")));
    expect(screen.queryByText("Late retry failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("sql-test-grid")).toHaveAttribute("data-result", result);
    expect(screen.getByRole("status", { name: "Result context" })).toHaveAttribute(
      "data-current",
      "true",
    );
    expect(api.startQuery).toHaveBeenCalledTimes(2);
  });
  it("keeps result and execution plan provenance independent", async () => {
    setup({
      startQuery: vi.fn(async (request) =>
        request.action === "execute"
          ? ready(request.runId)
          : {
              ...ready(request.runId),
              resultId: null,
              columns: [],
              rowCount: null,
              planText: "Plan A",
            },
      ),
    });
    await screen.findByRole("button", { name: "orders" });
    const editor = screen.getByRole("textbox", { name: "SQL editor" });
    replaceEditorText(editor, "SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await screen.findByRole("status", { name: "Plan context" });
    replaceEditorText(editor, "SELECT 2");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const result = await screen.findByRole("status", { name: "Result context" });
    expect(result).toHaveAttribute("data-current", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Execution plan" }));
    expect(screen.getByRole("status", { name: "Plan context" })).toHaveTextContent(
      "SQL changed · previous plan",
    );
    replaceEditorText(editor, "SELECT 1");
    expect(screen.getByRole("status", { name: "Plan context" })).toHaveAttribute(
      "data-current",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(result).toHaveTextContent("SQL changed · previous result");
  });
  it("persists only the help-open preference across remounts", async () => {
    const first = setup();
    await screen.findByRole("button", { name: "orders" });
    fireEvent.click(screen.getByRole("button", { name: "Examples & help" }));
    expect(localStorage.getItem(SQL_HELP_PREFERENCE_KEY)).toBe("false");
    first.unmount();
    setup();
    await screen.findByRole("button", { name: "orders" });
    expect(screen.getByRole("button", { name: "Examples & help" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(Object.keys(localStorage)).toEqual([SQL_HELP_PREFERENCE_KEY]);
    fireEvent.click(screen.getByRole("button", { name: "Examples & help" }));
    expect(localStorage.getItem(SQL_HELP_PREFERENCE_KEY)).toBe("true");
  });
  it("defaults help open for invalid storage and keeps toggling safe when storage throws", async () => {
    localStorage.setItem(SQL_HELP_PREFERENCE_KEY, "not-a-boolean");
    const first = setup();
    await screen.findByRole("button", { name: "orders" });
    expect(screen.getByRole("button", { name: "Examples & help" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    first.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    setup();
    await screen.findByRole("button", { name: "orders" });
    fireEvent.click(screen.getByRole("button", { name: "Examples & help" }));
    expect(screen.getByRole("button", { name: "Examples & help" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("textbox", { name: "SQL editor" })).toBeInTheDocument();
  });
  it("selects through the path, mode, card button, Enter and Space", async () => {
    const user = userEvent.setup();
    setup();
    const first = await screen.findByRole("button", { name: "orders" });
    const second = screen.getByRole("button", { name: "orders_2" });
    const scrollSelectedIntoView = vi.fn();
    second.scrollIntoView = scrollSelectedIntoView;
    const path = within(second).getByText("D:/orders.csv");
    const mode = within(second).getByText("c-numbers only");
    expect(path.closest("button")).toBe(second);
    expect(mode.closest("button")).toBe(second);
    expect(second.querySelector("button")).toBeNull();
    await user.click(path);
    expect(scrollSelectedIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(second).toHaveAttribute("aria-pressed", "true");
    await user.click(first);
    await user.click(mode);
    expect(second).toHaveAttribute("aria-pressed", "true");
    await user.click(first);
    await user.click(second);
    expect(second).toHaveAttribute("aria-pressed", "true");
    first.focus();
    await user.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-pressed", "true");
    second.focus();
    await user.keyboard(" ");
    expect(second).toHaveAttribute("aria-pressed", "true");
  });
  it("keeps pencil, alias input, save and cancel independent of source selection", async () => {
    const user = userEvent.setup();
    setup();
    const first = await screen.findByRole("button", { name: "orders" });
    await user.click(screen.getByRole("button", { name: "Rename table orders_2" }));
    const input = screen.getByRole("textbox", { name: "Table alias" });
    await user.clear(input);
    await user.type(input, "archive");
    expect(first).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Save table alias" }));
    expect(first).toHaveAttribute("aria-pressed", "true");
    const renamed = screen.getByRole("button", { name: "archive" });
    expect(renamed).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Rename table archive" }));
    await user.click(screen.getByRole("button", { name: "Cancel alias edit" }));
    expect(first).toHaveAttribute("aria-pressed", "true");
    await user.dblClick(renamed);
    expect(screen.getByRole("textbox", { name: "Table alias" })).toHaveValue("archive");
    expect(renamed).toHaveAttribute("aria-pressed", "true");
  });
  it.each([
    {
      error: null,
      message: "SQL execution cancelled. The previous successful result is unchanged.",
    },
    {
      error: {
        code: "TaskCancelled",
        message: "SQL execution cancelled because a source file was closed.",
      },
      message: "SQL execution cancelled because a source file was closed.",
    },
  ])(
    "shows cancellation reason $message and retains the successful snapshot",
    async ({ error, message }) => {
      const { api } = setup();
      await screen.findByRole("button", { name: "orders" });
      const input = screen.getByRole("textbox", { name: "SQL editor" });
      replaceEditorText(input, "SELECT 1");
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      const result = await screen.findByTestId("sql-test-grid");
      const identity = result.getAttribute("data-result");
      vi.mocked(api.startQuery).mockImplementationOnce(async (request) => ({
        ...ready(request.runId),
        state: "cancelled",
        resultId: null,
        columns: [],
        rowCount: null,
        error,
      }));
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() =>
        expect(screen.getByText(message, { selector: ".sql-notice span" })).toBeVisible(),
      );
      expect(screen.getByTestId("sql-test-grid")).toHaveAttribute("data-result", identity);
      expect(editorView(input).state.doc.toString()).toBe("SELECT 1");
      expect(api.releaseResult).not.toHaveBeenCalled();
      if (error) {
        fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
        expect(
          within(screen.getByRole("tabpanel", { name: "Messages" })).getByText(message),
        ).toBeVisible();
      }
    },
  );
  it("removes old source suggestions while refreshed descriptors are pending", async () => {
    const { api, props, rerender } = setup();
    await screen.findByRole("button", { name: "orders" });
    const input = screen.getByRole("textbox", { name: "SQL editor" });
    replaceEditorText(input, "SELECT * FROM ord");
    const editor = editorView(input);
    act(() => startCompletion(editor));
    await waitFor(() => expect(completionStatus(editor.state)).toBe("active"));
    expect(currentCompletions(editor.state).some((item) => item.label === "orders")).toBe(true);
    vi.mocked(api.describeTables).mockImplementationOnce(() => new Promise(() => {}));
    rerender(
      <SqlWorkspace
        {...props}
        sources={[...sources, { documentId: "new", sessionId: "new-session" }]}
      />,
    );
    await waitFor(() => expect(api.describeTables).toHaveBeenCalledTimes(2));
    act(() => startCompletion(editor));
    await waitFor(() => expect(completionStatus(editor.state)).not.toBe("pending"));
    expect(currentCompletions(editor.state)).toEqual([]);
    expect(editor.state.doc.toString()).toBe("SELECT * FROM ord");
  });
  it("has exactly one native radio per table and keeps existing SQL on mode/alias changes", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "orders" });
    const input = screen.getByRole("textbox", { name: "SQL editor" });
    replaceEditorText(input, 'SELECT "tail" FROM orders');
    fireEvent.click(screen.getByRole("radio", { name: /c-numbers only/ }));
    expect(screen.getByRole("radio", { name: /c-numbers only/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Original names only/ })).not.toBeChecked();
    expect(editorView(input).state.doc.toString()).toBe('SELECT "tail" FROM orders');
    fireEvent.click(screen.getByRole("button", { name: "orders_2" }));
    expect(screen.getByRole("radio", { name: /Original names only/ })).toBeDisabled();
    expect(screen.getByText("Duplicate original name")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    expect(screen.getByRole("radio", { name: /c-numbers only/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Rename table orders" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Table alias" }), {
      target: { value: "orders_2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save table alias" }));
    expect(screen.getByText(/alias is already/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Table alias" }), {
      target: { value: "current" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save table alias" }));
    expect(editorView(input).state.doc.toString()).toBe('SELECT "tail" FROM orders');
    fireEvent.click(screen.getByRole("button", { name: "Insert example" }));
    expect(editorView(input).state.doc.toString()).toBe('SELECT *\nFROM "current"\nLIMIT 100;');
    expect(api.startQuery).not.toHaveBeenCalled();
  });
  it("inserts escaped names and original ordinal gaps, keeping editor shortcuts local", async () => {
    setup();
    await screen.findByRole("button", { name: "orders" });
    const input = screen.getByRole("textbox", { name: "SQL editor" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search SQL columns" }), {
      target: { value: "名前" },
    });
    const list = screen.getByLabelText("SQL column list");
    fireEvent.doubleClick(within(list).getByRole("button"));
    await waitFor(() => expect(editorView(input).state.doc.toString()).toBe('"商品 ""名前"""'));
    fireEvent.click(screen.getByRole("radio", { name: /c-numbers only/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search SQL columns" }), {
      target: { value: "c38" },
    });
    expect(within(list).getByRole("button")).toHaveTextContent("c38");
    expect(within(list).queryByText("c2")).not.toBeInTheDocument();
  });
  it("retains the previous successful independent result when a later run fails", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "orders" });
    replaceEditorText(screen.getByRole("textbox", { name: "SQL editor" }), "SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("sql-test-grid");
    const before = screen.getByTestId("sql-test-grid").getAttribute("data-result");
    expect(within(screen.getByTestId("sql-test-grid")).getAllByText("duplicate")).toHaveLength(2);
    vi.mocked(api.startQuery).mockRejectedValueOnce(new Error("invalid SQL"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("invalid SQL");
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(screen.getByTestId("sql-test-grid")).toHaveAttribute("data-result", before);
    expect(screen.getByText(/previous successful result/)).toBeVisible();
    expect(api.releaseResult).not.toHaveBeenCalled();
  });
  it("drops a stale first-page completion instead of replacing a newer result", async () => {
    let resolveFirst!: (value: DataPage) => void;
    const first = new Promise<DataPage>((resolve) => {
      resolveFirst = resolve;
    });
    let firstSession = "";
    const readPage = vi
      .fn<SqlWorkspaceBackend["readPage"]>()
      .mockImplementationOnce(async (request) => {
        firstSession = request.resultId;
        return first;
      })
      .mockImplementation(async (request) => page(request.resultId, "new-result"));
    const { api } = setup({ readPage });
    await screen.findByRole("button", { name: "orders" });
    replaceEditorText(screen.getByRole("textbox", { name: "SQL editor" }), "SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("new-result");
    const expected = screen.getByTestId("sql-test-grid").getAttribute("data-result");
    await act(async () => resolveFirst(page(firstSession, "stale-result")));
    expect(screen.getByTestId("sql-test-grid")).toHaveAttribute("data-result", expected);
    expect(screen.queryByText("stale-result")).not.toBeInTheDocument();
    expect(api.releaseResult).toHaveBeenCalled();
  });
});
