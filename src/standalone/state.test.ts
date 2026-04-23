import {
  loadStandaloneRuntimeState,
  saveStandaloneRuntimeState,
  type StandaloneRuntimeState,
} from "./state.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function mkTmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cw-state-"));
}

describe("standalone runtime state", () => {
  it("loads default runtime state when file does not exist", () => {
    const dir = mkTmpStateDir();
    process.env.CLAUDE_WEIXIN_STATE_DIR = dir;

    const state = loadStandaloneRuntimeState();
    expect(state.version).toBe(1);
    expect(state.users).toEqual({});
  });

  it("migrates legacy runtime with getUpdatesBuf only", () => {
    const dir = mkTmpStateDir();
    process.env.CLAUDE_WEIXIN_STATE_DIR = dir;

    fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ getUpdatesBuf: "abc" }), "utf-8");

    const state = loadStandaloneRuntimeState();
    expect(state.version).toBe(1);
    expect(state.getUpdatesBuf).toBe("abc");
    expect(state.users).toEqual({});
  });

  it("round-trips normalized runtime state", () => {
    const dir = mkTmpStateDir();
    process.env.CLAUDE_WEIXIN_STATE_DIR = dir;

    const runtime: StandaloneRuntimeState = {
      version: 1,
      getUpdatesBuf: "cursor",
      users: {
        u1: {
          focusedSessionId: "s1",
          sessionOrder: ["s1"],
          sessions: {
            s1: {
              id: "s1",
              claudeSessionId: "c1",
              title: "task",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              turnCount: 1,
              initialized: true,
            },
          },
        },
      },
    };

    saveStandaloneRuntimeState(runtime);
    const loaded = loadStandaloneRuntimeState();
    expect(loaded).toEqual(runtime);
  });
});
