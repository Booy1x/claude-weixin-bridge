import { execFile } from "node:child_process";
import crypto from "node:crypto";

import type {
  AgentBackend,
  AgentBackendConfig,
  AgentTurnInput,
  AgentTurnResult,
} from "./agent.js";

interface ClaudeOutput {
  text: string;
  toolSummaries: string[];
  /** Session id reported by the CLI (`session_id` in JSON output), if any. */
  sessionId?: string;
}

/**
 * Parse the stdout of `claude --print --output-format json`.
 *
 * The single-result envelope looks like:
 *   { "type": "result", "result": "<text>", "session_id": "<uuid>", ... }
 *
 * Older / streaming shapes may instead carry `text` plus a `content` array of
 * blocks (including `tool_use`); both are handled best-effort. Plain text
 * output (no `--output-format json`) falls through to the text branch.
 */
export function parseClaudeOutput(output: string): ClaudeOutput {
  const trimmed = output.trim();
  if (!trimmed) return { text: "", toolSummaries: [] };
  try {
    const parsed = JSON.parse(trimmed) as {
      text?: string;
      result?: string;
      session_id?: string;
      content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }>;
    };
    const text = parsed.result ?? parsed.text ?? "";
    const sessionId = typeof parsed.session_id === "string" && parsed.session_id ? parsed.session_id : undefined;
    const toolSummaries: string[] = [];

    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (block.type === "tool_use" && block.name) {
          const input = block.input || {};
          let detail = "";
          if (
            (block.name === "Write" || block.name === "Edit" || block.name === "Read") &&
            typeof input.file_path === "string"
          ) {
            detail = input.file_path;
          }
          toolSummaries.push(detail ? `${block.name} ${detail}` : block.name);
        }
      }
    }

    return { text, toolSummaries, sessionId };
  } catch {
    return { text: trimmed, toolSummaries: [] };
  }
}

/**
 * Build the argv for one Claude turn.
 *
 * First turn of a session uses `--session-id <uuid>` to create it with a known
 * id; subsequent turns use `--resume <uuid>` so Claude restores the full
 * conversation from its own on-disk store (durable across bridge restarts).
 */
export function buildClaudeTurnArgs(opts: {
  sessionId: string;
  prompt: string;
  startNewSession: boolean;
  systemPrompt?: string;
  extraArgs?: string[];
}): string[] {
  const args: string[] = ["--print", "--output-format", "json"];
  args.push(opts.startNewSession ? "--session-id" : "--resume", opts.sessionId);
  if (opts.systemPrompt?.trim()) {
    args.push("--system-prompt", opts.systemPrompt.trim());
  }
  if (opts.extraArgs?.length) {
    args.push(...opts.extraArgs);
  }
  args.push(opts.prompt);
  return args;
}

/** Detect the "resume target does not exist" failure so we can fall back. */
export function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no conversation found/i.test(msg)) return true;
  if (/no session found/i.test(msg)) return true;
  return /session/i.test(msg) && /not found/i.test(msg);
}

function pickEnv(allowlist: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  for (const key of allowlist) {
    const clean = key.trim();
    if (!clean) continue;
    const value = process.env[clean];
    if (value !== undefined) env[clean] = value;
  }
  return env;
}

async function execClaude(
  cfg: AgentBackendConfig,
  args: string[],
  cwd?: string,
): Promise<ClaudeOutput> {
  const env = pickEnv(cfg.envAllowlist);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      cfg.command,
      args,
      {
        timeout: cfg.timeoutMs,
        maxBuffer: Math.max(cfg.maxOutputChars * 4, 64 * 1024),
        env,
        ...(cwd ? { cwd } : {}),
      },
      (err, out, stderr) => {
        if (err) {
          reject(new Error(`claude exec failed: ${err.message}${stderr?.trim() ? ` stderr=${stderr.trim()}` : ""}`));
          return;
        }
        resolve(out ?? "");
      },
    );
  });

  const result = parseClaudeOutput(stdout);
  if (result.text.length > cfg.maxOutputChars) {
    result.text = result.text.slice(0, cfg.maxOutputChars);
  }
  return result;
}

/**
 * Claude Code backend: drives the `claude` CLI with native session resume.
 *
 * Context lives in Claude's own session store, not in bridge memory, so it
 * survives restarts and is not truncated to a few recent turns. If a resume
 * fails (e.g. the session was never persisted, or lives under a different
 * working directory), the turn is transparently retried as a fresh session.
 */
export class ClaudeBackend implements AgentBackend {
  readonly name = "claude";

  newSessionId(): string {
    return crypto.randomUUID();
  }

  async runTurn(cfg: AgentBackendConfig, input: AgentTurnInput): Promise<AgentTurnResult> {
    const attempt = async (sessionId: string, startNewSession: boolean): Promise<ClaudeOutput> => {
      const args = buildClaudeTurnArgs({
        sessionId,
        prompt: input.prompt,
        startNewSession,
        systemPrompt: cfg.systemPrompt,
        extraArgs: cfg.extraArgs,
      });
      return execClaude(cfg, args, input.cwd);
    };

    try {
      const out = await attempt(input.sessionId, input.startNewSession);
      return {
        text: out.text,
        toolSummaries: out.toolSummaries,
        sessionId: out.sessionId || input.sessionId,
        startedNewSession: input.startNewSession,
      };
    } catch (err) {
      if (!input.startNewSession && isSessionNotFoundError(err)) {
        const fresh = this.newSessionId();
        const out = await attempt(fresh, true);
        return {
          text: out.text,
          toolSummaries: out.toolSummaries,
          sessionId: out.sessionId || fresh,
          startedNewSession: true,
        };
      }
      throw err;
    }
  }
}
