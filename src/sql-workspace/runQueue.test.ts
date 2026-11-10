import { describe, expect, it } from "vitest";
import { createSqlRunQueue } from "./runQueue";

describe("SQL tab run queue", () => {
  it("runs tabs in arrival order and removes a cancelled waiting tab", async () => {
    const queue = createSqlRunQueue();
    const active = await queue.enter(new AbortController().signal);
    const cancel = new AbortController();
    const cancelled = expect(queue.enter(cancel.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const next = queue.enter(new AbortController().signal);
    expect(queue.busy).toBe(true);
    cancel.abort();
    await cancelled;
    active();
    const finish = await next;
    expect(queue.busy).toBe(true);
    finish();
    expect(queue.busy).toBe(false);
  });
});
