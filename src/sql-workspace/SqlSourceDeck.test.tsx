// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SqlSourceDeck } from "./SqlSourceDeck";

function Context({ name, active }: { name: string; active: boolean }) {
  const [row, setRow] = useState(1);
  return (
    <button onClick={() => setRow((value) => value + 1)} data-active={active}>
      {name}: selected row {row}
    </button>
  );
}

it("retains source-local UI state while switching and bounds mounted contexts", () => {
  const source = (documentId: string) => ({ documentId, sessionId: documentId });
  const frame = (id: string, active = true) => (
    <SqlSourceDeck
      source={source(id)}
      active={active}
      renderSource={(item, visible) => <Context name={item.documentId} active={visible} />}
    />
  );
  const ui = render(frame("orders"));
  fireEvent.click(screen.getByRole("button", { name: "orders: selected row 1" }));
  ui.rerender(frame("customers"));
  expect(screen.queryByRole("button", { name: "orders: selected row 2" })).not.toBeInTheDocument();
  ui.rerender(frame("orders"));
  expect(screen.getByRole("button", { name: "orders: selected row 2" })).toHaveAttribute(
    "data-active",
    "true",
  );
  ui.rerender(frame("items"));
  ui.rerender(frame("products"));
  expect(ui.container.querySelectorAll("button")).toHaveLength(3);
  ui.rerender(frame("products", false));
  expect(screen.getByRole("button", { name: "products: selected row 1" })).toHaveAttribute(
    "data-active",
    "false",
  );
});
