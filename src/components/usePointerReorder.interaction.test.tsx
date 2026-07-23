// @vitest-environment jsdom

import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePointerReorder } from "./usePointerReorder";

describe("pointer reorder cancellation", () => {
  it("does not suppress the first real click after pointer cancellation", () => {
    function Harness() {
      const containerRef = useRef<HTMLDivElement>(null);
      const [clicks, setClicks] = useState(0);
      const reorder = usePointerReorder({
        ids: ["a", "b"],
        containerRef,
        orientation: "horizontal",
        onCommit: vi.fn(),
      });
      return (
        <div ref={containerRef}>
          <button
            {...reorder.getItemProps("a")}
            onClick={() => {
              if (!reorder.consumeSuppressedClick("a")) setClicks((current) => current + 1);
            }}
            type="button"
          >
            A
          </button>
          <button {...reorder.getItemProps("b")} type="button">
            B
          </button>
          <output aria-label="clicks">{clicks}</output>
        </div>
      );
    }

    render(<Harness />);
    const button = screen.getByRole("button", { name: "A" });
    Object.assign(button, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(button, { button: 0, isPrimary: true, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 12 });
    fireEvent.pointerCancel(button, { pointerId: 1 });
    fireEvent.click(button);
    expect(screen.getByLabelText("clicks")).toHaveTextContent("1");
  });
});
