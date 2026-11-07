// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SqlPlan } from "./SqlPlan";

describe("SqlPlan", () => {
  it("compares measured operators inside a profile wrapper and shows the selected details", () => {
    render(
      <SqlPlan
        status={{
          planText: null,
          planJson: JSON.stringify({
            latency: 0.15,
            cpu_time: 0.08,
            children: [
              {
                operator_name: "HASH_JOIN",
                operator_timing: 0.01,
                operator_cardinality: 12,
                extra_info: { "Estimated Cardinality": "18", Conditions: "a.id = b.id" },
                children: [
                  { operator_name: "TABLE_SCAN", operator_timing: 0.03 },
                  { operator_name: "FILTER", operator_timing: 0 },
                  { operator_name: "PROJECTION" },
                ],
              },
            ],
          }),
        }}
      />,
    );

    const summary = within(screen.getByRole("region", { name: "Operator timing summary" }));
    expect(summary.getByText("TABLE_SCAN")).toBeVisible();
    expect(summary.getByText("30 ms · 75%")).toBeVisible();
    expect(summary.getByText("Share of total measured operator time")).toBeVisible();

    const tree = within(screen.getByRole("region", { name: "Execution plan nodes" }));
    expect(tree.getByRole("button", { name: "HASH_JOIN 10 ms 25%" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(tree.getByRole("button", { name: "FILTER 0 ms" })).toBeVisible();
    expect(tree.getByRole("button", { name: "PROJECTION" })).toBeVisible();

    const detail = within(screen.getByRole("region", { name: "Execution plan detail" }));
    expect(detail.getByText("18")).toBeVisible();
    expect(detail.getByText("12")).toBeVisible();
    expect(detail.getByText("a.id = b.id")).toBeVisible();
    const scan = tree.getByRole("button", { name: "TABLE_SCAN Slowest 30 ms 75%" });
    fireEvent.click(scan);
    expect(scan).toHaveAttribute("aria-pressed", "true");
    expect(detail.getByText("TABLE_SCAN")).toBeVisible();
    expect(detail.queryByText("a.id = b.id")).toBeNull();
  });

  it("keeps the raw plan and copies it when no operator timing is available", async () => {
    const rawPlan = "Original DuckDB plan text";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<SqlPlan status={{ planText: rawPlan, planJson: [{ name: "PROJECTION" }] }} />);
      expect(screen.queryByRole("region", { name: "Operator timing summary" })).toBeNull();
      expect(screen.getByRole("button", { name: "PROJECTION" })).toBeVisible();
      fireEvent.click(screen.getByText("Raw execution plan"));
      expect(screen.getByText(rawPlan)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Copy execution plan" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Execution plan copied.");
      expect(writeText).toHaveBeenCalledWith(rawPlan);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("shows zero duration without a bottleneck share when all measured times are zero", () => {
    render(
      <SqlPlan
        status={{ planText: null, planJson: [{ operator_name: "SCAN", operator_timing: 0 }] }}
      />,
    );
    expect(screen.getByRole("button", { name: "SCAN 0 ms" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Operator timing summary" })).toBeNull();
  });
});
