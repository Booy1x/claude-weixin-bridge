import { describe, it, expect } from "vitest";

import { KeyedTaskQueue } from "./task-queue.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedTaskQueue", () => {
  it("runs tasks with the same key strictly in order", async () => {
    const q = new KeyedTaskQueue();
    const order: string[] = [];

    const a = q.enqueue("k", async () => {
      await tick(20);
      order.push("a");
    });
    const b = q.enqueue("k", async () => {
      order.push("b");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("runs tasks with different keys concurrently", async () => {
    const q = new KeyedTaskQueue();
    const order: string[] = [];

    const slow = q.enqueue("k1", async () => {
      await tick(30);
      order.push("slow");
    });
    const fast = q.enqueue("k2", async () => {
      order.push("fast");
    });

    await Promise.all([slow, fast]);
    // The fast (different-key) task finishes before the slow one.
    expect(order).toEqual(["fast", "slow"]);
  });

  it("keeps the lane running after a task rejects", async () => {
    const q = new KeyedTaskQueue();
    const ran: string[] = [];

    const failing = q.enqueue("k", async () => {
      throw new Error("boom");
    });
    const next = q.enqueue("k", async () => {
      ran.push("next");
    });

    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(ran).toEqual(["next"]);
  });

  it("drops the key once its lane drains", async () => {
    const q = new KeyedTaskQueue();
    const p = q.enqueue("k", async () => {
      await tick(5);
    });
    expect(q.isActive("k")).toBe(true);
    expect(q.activeKeys).toBe(1);
    await p;
    await tick(0);
    expect(q.isActive("k")).toBe(false);
    expect(q.activeKeys).toBe(0);
  });
});
