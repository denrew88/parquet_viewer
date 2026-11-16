import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkspaceReference } from "./WorkspaceReference";

it("keeps the chosen view and cached preview across workspace switches", async () => {
  const readPreview = vi.fn(async () => ({
    sessionId: "session",
    offset: 0,
    limit: 6,
    totalRows: 1,
    hasMore: false,
    columns: ["amount"],
    rows: [[{ kind: "int" as const, display: "123" }]],
  }));
  const props = {
    kind: "file" as const,
    name: "orders.csv",
    columns: [{ id: "amount", name: "Amount", logicalType: "BIGINT" }],
    readPreview,
  };
  const { rerender } = render(<WorkspaceReference {...props} active={false} />);
  expect(readPreview).not.toHaveBeenCalled();
  rerender(<WorkspaceReference {...props} active />);
  expect(await screen.findByText("123")).toBeVisible();
  expect(readPreview).toHaveBeenCalledWith(6, ["amount"]);

  fireEvent.click(screen.getByRole("button", { name: "Schema" }));
  rerender(<WorkspaceReference {...props} active={false} />);
  rerender(<WorkspaceReference {...props} active />);
  expect(screen.getByRole("table", { name: "Source schema" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Data Preview" }));
  expect(await screen.findByText("123")).toBeVisible();
  expect(readPreview).toHaveBeenCalledTimes(1);
});

it("includes the chart columns in the bounded snapshot preview and shows its row count", async () => {
  const columns = Array.from({ length: 12 }, (_, index) => ({
    id: `c${index}`,
    name: `Column ${index}`,
    logicalType: "BIGINT",
  }));
  const readPreview = vi.fn(async (_limit: number, ids: string[]) => ({
    sessionId: "captured",
    offset: 0,
    limit: 6,
    totalRows: 10,
    hasMore: true,
    columns: ids,
    rows: Array.from({ length: 6 }, (_, row) =>
      ids.map((id) => ({ kind: "int" as const, display: `${id}-${row}` })),
    ),
  }));
  render(
    <WorkspaceReference
      active
      name="Selected cells"
      kind="selection"
      columns={columns}
      chartColumnIds={["c0", "c11"]}
      readPreview={readPreview}
    />,
  );
  expect(await screen.findByText("c11-5")).toBeVisible();
  expect(readPreview).toHaveBeenCalledWith(6, ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c11"]);
  expect(screen.getByText("1–6 / 10 rows", { exact: false })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "Column 11" })).toHaveAttribute(
    "data-chart-column",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Schema" }));
  expect(screen.getByRole("table", { name: "Source schema" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Selection Preview" }));
  expect(screen.getByText("c11-5")).toBeVisible();
  expect(readPreview).toHaveBeenCalledTimes(1);
});
