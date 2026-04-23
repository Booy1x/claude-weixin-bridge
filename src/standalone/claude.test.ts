import { buildSessionArgs } from "./claude.js";

describe("buildSessionArgs", () => {
  it("builds sync mode args with fork-session", () => {
    const args = buildSessionArgs(["-p", "{{prompt}}"], {
      mode: "sync",
      sessionId: "sid-1",
      prompt: "sync prompt",
    });

    expect(args).toEqual(["-p", "-r", "sid-1", "--fork-session", "sync prompt"]);
  });

  it("injects resume flag before default print args in chat mode", () => {
    const args = buildSessionArgs(["-p", "{{prompt}}"], {
      mode: "chat",
      sessionId: "sid-2",
      prompt: "hello",
    });

    expect(args).toEqual(["-r", "sid-2", "-p", "hello"]);
  });

  it("uses --session-id when starting a new chat session", () => {
    const args = buildSessionArgs(["-p", "{{prompt}}"], {
      mode: "chat",
      sessionId: "sid-2",
      prompt: "hello",
      startNewSession: true,
    });

    expect(args).toEqual(["--session-id", "sid-2", "-p", "hello"]);
  });

  it("falls back to print form when args template has no print flag", () => {
    const args = buildSessionArgs(["{{prompt}}"], {
      mode: "chat",
      sessionId: "sid-3",
      prompt: "hello",
    });

    expect(args).toEqual(["-p", "-r", "sid-3", "hello"]);
  });
});
