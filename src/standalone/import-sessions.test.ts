import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractSessionHistory } from "./import-sessions.js";

function mkTmpFile(name: string, lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-import-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

describe("extractSessionHistory", () => {
  it("returns empty array for non-existent file", () => {
    const result = extractSessionHistory("/nonexistent/file.jsonl");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const file = mkTmpFile("empty.jsonl", []);
    const result = extractSessionHistory(file);
    expect(result).toEqual([]);
  });

  it("extracts simple user/assistant pairs from streaming deltas", () => {
    const file = mkTmpFile("simple.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "你好" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "你" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好！" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "再见" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "再见！" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    // Should have 4 messages: user, assistant(merged), user, assistant
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: "你好" });
    expect(result[1]).toEqual({ role: "assistant", content: "你\n好！" });
    expect(result[2]).toEqual({ role: "user", content: "再见" });
    expect(result[3]).toEqual({ role: "assistant", content: "再见！" });
  });

  it("merges consecutive assistant deltas into one message", () => {
    const file = mkTmpFile("merge.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "A" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "1" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "2" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "3" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "A" });
    expect(result[1]).toEqual({ role: "assistant", content: "1\n2\n3" });
  });

  it("does not produce consecutive assistant messages", () => {
    const file = mkTmpFile("no-consec.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Q1" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "" } }),  // empty user
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A2" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Q2" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "B" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    // No consecutive assistants
    for (let i = 1; i < result.length; i++) {
      if (result[i].role === "assistant") {
        expect(result[i - 1].role).not.toBe("assistant");
      }
    }
    // Must start with user
    expect(result[0].role).toBe("user");
  });

  it("skips noisy user messages without breaking assistant merge", () => {
    const file = mkTmpFile("noisy.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Real question" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Th" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-caveat>skip</local-command-caveat>" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "inking..." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Response" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    // Only 1 user message (the real one), assistant merges all deltas
    // (including deltas after noisy user messages that were skipped)
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Real question" });
    expect(result[1]).toEqual({ role: "assistant", content: "Th\ninking...\nResponse" });
  });

  it("keeps only the last N user/assistant pairs", () => {
    const file = mkTmpFile("truncate.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Q1" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Q2" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A2" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Q3" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A3" }] } }),
    ]);

    const result = extractSessionHistory(file, 2, 1000);

    // Last 2 pairs = 4 messages
    expect(result).toHaveLength(4);
    expect(result[0].content).toBe("Q2");
    expect(result[1].content).toBe("A2");
    expect(result[2].content).toBe("Q3");
    expect(result[3].content).toBe("A3");
  });

  it("handles type:message entries (complete assistant responses)", () => {
    const file = mkTmpFile("message-type.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Hi" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Bye" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Goodbye!" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: "Hi" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hello!" });
    expect(result[2]).toEqual({ role: "user", content: "Bye" });
    expect(result[3]).toEqual({ role: "assistant", content: "Goodbye!" });
  });

  it("handles mixed streaming deltas and type:message entries", () => {
    const file = mkTmpFile("mixed.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Q1" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "delta" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "complete" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Q2" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    // delta is merged with the following type:message, then Q2, then reply
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: "Q1" });
    expect(result[1]).toEqual({ role: "assistant", content: "delta\ncomplete" });
    expect(result[2]).toEqual({ role: "user", content: "Q2" });
    expect(result[3]).toEqual({ role: "assistant", content: "reply" });
  });

  it("truncates long messages to maxChars", () => {
    const longText = "a".repeat(2000);
    const file = mkTmpFile("long.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Q" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: longText }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 500);

    expect(result[1].content.length).toBe(501); // 500 + "…"
    expect(result[1].content.endsWith("…")).toBe(true);
  });

  it("returns empty array when only assistant messages exist", () => {
    const file = mkTmpFile("only-assistant.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "orphan" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    expect(result).toEqual([]);
  });

  it("drops leading assistant messages before first user", () => {
    const file = mkTmpFile("leading-assistant.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "orphan" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Q" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A" }] } }),
    ]);

    const result = extractSessionHistory(file, 5, 1000);

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });
});
