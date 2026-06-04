import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ClaudeBackend,
  buildClaudeTurnArgs,
  isSessionNotFoundError,
  parseClaudeOutput,
} from "./claude.js";
import type { AgentBackendConfig } from "./agent.js";

describe("buildClaudeTurnArgs", () => {
  it("creates a session with --session-id on the first turn", () => {
    const args = buildClaudeTurnArgs({
      sessionId: "sid-1",
      prompt: "hello",
      startNewSession: true,
    });
    expect(args).toEqual(["--print", "--output-format", "json", "--session-id", "sid-1", "hello"]);
  });

  it("resumes with --resume on later turns", () => {
    const args = buildClaudeTurnArgs({
      sessionId: "sid-1",
      prompt: "hello",
      startNewSession: false,
    });
    expect(args).toEqual(["--print", "--output-format", "json", "--resume", "sid-1", "hello"]);
  });

  it("appends system prompt and extra args before the prompt", () => {
    const args = buildClaudeTurnArgs({
      sessionId: "sid-1",
      prompt: "hello",
      startNewSession: false,
      systemPrompt: "be terse",
      extraArgs: ["--model", "sonnet"],
    });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--resume",
      "sid-1",
      "--system-prompt",
      "be terse",
      "--model",
      "sonnet",
      "hello",
    ]);
  });
});

describe("parseClaudeOutput", () => {
  it("reads result text and session_id from the json envelope", () => {
    const out = parseClaudeOutput(JSON.stringify({ type: "result", result: "hi there", session_id: "abc" }));
    expect(out.text).toBe("hi there");
    expect(out.sessionId).toBe("abc");
    expect(out.toolSummaries).toEqual([]);
  });

  it("extracts tool_use summaries from a content array", () => {
    const out = parseClaudeOutput(
      JSON.stringify({
        text: "done",
        content: [
          { type: "tool_use", name: "Write", input: { file_path: "/tmp/a.ts" } },
          { type: "tool_use", name: "Bash" },
        ],
      }),
    );
    expect(out.text).toBe("done");
    expect(out.toolSummaries).toEqual(["Write /tmp/a.ts", "Bash"]);
  });

  it("falls back to plain text when output is not json", () => {
    const out = parseClaudeOutput("just text");
    expect(out.text).toBe("just text");
    expect(out.sessionId).toBeUndefined();
  });
});

describe("isSessionNotFoundError", () => {
  it("matches the resume-not-found error", () => {
    expect(isSessionNotFoundError(new Error("No conversation found with session id xyz"))).toBe(true);
    expect(isSessionNotFoundError(new Error("session abc not found"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isSessionNotFoundError(new Error("network timeout"))).toBe(false);
  });
});

describe("ClaudeBackend.runTurn", () => {
  let dir: string;
  let fakeCli: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fake-"));
    fakeCli = path.join(dir, "fake-claude.mjs");
    // Fake CLI: fails to --resume (mimicking a missing session) but succeeds
    // when creating via --session-id, echoing the id back as session_id.
    fs.writeFileSync(
      fakeCli,
      [
        "#!/usr/bin/env node",
        "const a = process.argv.slice(2);",
        "const r = a.indexOf('--resume');",
        "if (r !== -1) { process.stderr.write('No conversation found with session id ' + a[r+1]); process.exit(1); }",
        "const s = a.indexOf('--session-id');",
        "const sid = s !== -1 ? a[s+1] : 'unknown';",
        "process.stdout.write(JSON.stringify({ type: 'result', result: 'hello from fake', session_id: sid }));",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfg = (): AgentBackendConfig => ({
    command: fakeCli,
    timeoutMs: 10_000,
    maxOutputChars: 4000,
    envAllowlist: [],
  });

  it("returns text and the backend session id on a new session", async () => {
    const backend = new ClaudeBackend();
    const res = await backend.runTurn(cfg(), {
      sessionId: "sid-x",
      prompt: "hi",
      startNewSession: true,
    });
    expect(res.text).toBe("hello from fake");
    expect(res.sessionId).toBe("sid-x");
    expect(res.startedNewSession).toBe(true);
  });

  it("falls back to a fresh session when resume reports not found", async () => {
    const backend = new ClaudeBackend();
    const res = await backend.runTurn(cfg(), {
      sessionId: "stale-id",
      prompt: "hi",
      startNewSession: false,
    });
    expect(res.text).toBe("hello from fake");
    expect(res.startedNewSession).toBe(true);
    // The fallback generated a fresh UUID, not the stale one.
    expect(res.sessionId).not.toBe("stale-id");
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
