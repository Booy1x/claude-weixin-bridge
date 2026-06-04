/**
 * Per-key serial task queue.
 *
 * Tasks with the same key run strictly in order (a long-running turn for one
 * conversation never overlaps the next message for that same conversation),
 * while tasks with different keys run concurrently. The bridge keys by sender,
 * so one user's slow `claude` turn no longer blocks other users — nor the
 * polling loop, which dispatches without awaiting.
 */
export class KeyedTaskQueue {
  private chains = new Map<string, Promise<unknown>>();

  /** Enqueue `fn` under `key`; resolves/rejects with `fn`'s result. */
  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // Run `fn` whether or not the previous task in this chain succeeded.
    const run = prev.then(fn, fn);
    const tracked = run.catch(() => undefined);
    this.chains.set(key, tracked);
    // Drop the chain entry once it drains, so the map stays bounded.
    void tracked.then(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    return run;
  }

  /** Number of keys with in-flight or queued work. */
  get activeKeys(): number {
    return this.chains.size;
  }

  /** True when `key` currently has queued or running work. */
  isActive(key: string): boolean {
    return this.chains.has(key);
  }
}
