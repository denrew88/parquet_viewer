import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_QUERY_PLAN, type QueryPlan } from "./model";
import { QueryToolbar } from "./QueryToolbar";

const columns = [
  { id: "name", label: "Name", searchable: true },
  { id: "payload", label: "Payload", searchable: false, disabledReason: "Binary" },
];

describe("QueryToolbar", () => {
  it("debounces search options and exposes find navigation", () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    render(
      <QueryToolbar
        columns={columns}
        onClearFilters={vi.fn()}
        onFindNext={vi.fn()}
        onFindPrevious={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={onSearchChange}
        plan={EMPTY_QUERY_PLAN}
      />,
    );
    onSearchChange.mockClear();
    fireEvent.change(screen.getByLabelText("Search data"), { target: { value: "  Kim  " } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("button", { name: "Search options" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Case sensitive" }));
    expect(onSearchChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Kim", mode: "find", caseSensitive: true }),
    );
    expect(screen.getByRole("button", { name: "Previous match" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders bounded filter chips and exposes hidden filters through an accessible menu", async () => {
    const user = userEvent.setup();
    const onRemoveFilter = vi.fn();
    const onClearFilters = vi.fn();
    const filters = Array.from({ length: 5 }, (_, index) => ({
      id: `f${index}`,
      columnId: `column_${index}`,
      scalarType: "text" as const,
      operator: "equals" as const,
      values: [`value_${index}`],
    }));
    const plan: QueryPlan = { ...EMPTY_QUERY_PLAN, filters };
    render(
      <QueryToolbar
        columns={columns}
        onClearFilters={onClearFilters}
        onRemoveFilter={onRemoveFilter}
        onSearchChange={vi.fn()}
        plan={plan}
      />,
    );
    const overflowTrigger = screen.getByRole("button", { name: "+2 filters" });
    overflowTrigger.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { name: "Hidden active filters" });
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(
      screen.queryByRole("menuitem", { name: "Remove filter column_0" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove filter column_3" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Remove filter column_4" })).toHaveFocus();
    await user.click(screen.getByRole("menuitem", { name: "Remove filter column_3" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("f3");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Hidden active filters" })).not.toBeInTheDocument();
    expect(overflowTrigger).toHaveFocus();

    await user.keyboard("[Space]");
    expect(screen.getByRole("menu", { name: "Hidden active filters" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Hidden active filters" })).not.toBeInTheDocument();

    await user.click(overflowTrigger);
    expect(screen.getByRole("menu", { name: "Hidden active filters" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Remove filter column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("f0");
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("clamps the hidden-filter menu inside an 800x600 viewport", () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("query-filter-overflow__menu")) {
          return {
            bottom: 300,
            height: 300,
            left: 0,
            right: 320,
            top: 0,
            width: 320,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        }
        if (this.textContent?.includes("+2 filters")) {
          return {
            bottom: 599,
            height: 29,
            left: 760,
            right: 800,
            top: 570,
            width: 40,
            x: 760,
            y: 570,
            toJSON: () => ({}),
          };
        }
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      });
    try {
      const filters = Array.from({ length: 5 }, (_, index) => ({
        id: `f${index}`,
        columnId: `column_${index}`,
        scalarType: "text" as const,
        operator: "equals" as const,
        values: [`value_${index}`],
      }));
      render(
        <QueryToolbar
          columns={columns}
          onClearFilters={vi.fn()}
          onRemoveFilter={vi.fn()}
          onSearchChange={vi.fn()}
          plan={{ ...EMPTY_QUERY_PLAN, filters }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "+2 filters" }));
      const menu = screen.getByRole("menu", { name: "Hidden active filters" });
      expect(menu).toHaveStyle({ left: "472px", top: "266px" });
    } finally {
      rect.mockRestore();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

  it("keeps unsearchable targets disabled and cancels a running query", () => {
    const onCancelQuery = vi.fn();
    render(
      <QueryToolbar
        columns={columns}
        onCancelQuery={onCancelQuery}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={vi.fn()}
        plan={EMPTY_QUERY_PLAN}
        status={{ state: "running", message: "Scanning", matchCount: 12 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search options" }));
    const menu = screen.getByRole("menu", { name: "Search options" });
    const excluded = screen.getByRole("menuitemcheckbox", {
      name: "Payload Excluded: Binary",
    });
    expect(excluded).toHaveAttribute("aria-disabled", "true");
    expect(excluded).not.toBeDisabled();
    expect(screen.getByText("Excluded: Binary")).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: "Case sensitive" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(excluded).toHaveFocus();
    fireEvent.click(excluded);
    expect(excluded).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/12 matches/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps debounce stable across callback rerenders and scopes an empty target to visible columns", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const { rerender } = render(
      <QueryToolbar
        columns={columns}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={first}
        plan={EMPTY_QUERY_PLAN}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search data"), { target: { value: "Kim" } });
    const latest = vi.fn();
    rerender(
      <QueryToolbar
        columns={columns}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={latest}
        plan={EMPTY_QUERY_PLAN}
      />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(latest).toHaveBeenCalledWith(expect.objectContaining({ targetColumnIds: ["name"] }));
    expect(first).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("supports target-menu keyboard close and exposes query errors as retryable alerts", () => {
    const onRetryQuery = vi.fn();
    render(
      <QueryToolbar
        columns={columns}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onRetryQuery={onRetryQuery}
        onSearchChange={vi.fn()}
        plan={EMPTY_QUERY_PLAN}
        status={{ state: "error", message: "Disk full", matchCount: null }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Search options" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryQuery).toHaveBeenCalledTimes(1);
  });

  it("removes hidden explicit targets and names the trigger from visible selection", () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    const plan: QueryPlan = {
      ...EMPTY_QUERY_PLAN,
      search: {
        text: "Kim",
        mode: "filter",
        caseSensitive: false,
        exact: false,
        targetColumnIds: ["name", "age"],
      },
    };
    const { rerender } = render(
      <QueryToolbar
        columns={[
          { id: "name", label: "Name", searchable: true },
          { id: "age", label: "Age", searchable: true },
        ]}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={onSearchChange}
        plan={plan}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search options" }));
    expect(screen.getByText("2 visible columns")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    rerender(
      <QueryToolbar
        columns={[{ id: "name", label: "Name", searchable: true }]}
        onClearFilters={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSearchChange={onSearchChange}
        plan={plan}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search options" }));
    expect(screen.getByText("1 visible column")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetColumnIds: ["name"] }),
    );
    vi.useRealTimers();
  });

  it("clamps the search-target menu inside an 800x600 viewport", () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("query-targets__menu")) {
          return {
            bottom: 300,
            height: 300,
            left: 0,
            right: 240,
            top: 0,
            width: 240,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        }
        if (this.getAttribute("aria-label") === "Search options") {
          return {
            bottom: 599,
            height: 29,
            left: 760,
            right: 800,
            top: 570,
            width: 40,
            x: 760,
            y: 570,
            toJSON: () => ({}),
          };
        }
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      });
    try {
      render(
        <QueryToolbar
          columns={columns}
          onClearFilters={vi.fn()}
          onRemoveFilter={vi.fn()}
          onSearchChange={vi.fn()}
          plan={EMPTY_QUERY_PLAN}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Search options" }));
      expect(screen.getByRole("menu", { name: "Search options" })).toHaveStyle({
        left: "552px",
        top: "266px",
      });
    } finally {
      rect.mockRestore();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });
});
