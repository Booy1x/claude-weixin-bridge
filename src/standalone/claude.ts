import { execFile } from "node:child_process";

export type StandaloneClaudeInput = {
  from: string;
  body: string;
};

export type StandaloneClaudeMode = "chat" | "sync";

export type StandaloneClaudeSessionOptions = {
  mode: StandaloneClaudeMode;
  sessionId: string;
  prompt: string;
  startNewSession?: boolean;
};

export type StandaloneClaudeConfig = {
  command: string;
  argsTemplate: string[];
  timeoutMs: number;
  maxOutputChars: number;
  envAllowlist: string[];
  systemPrompt?: string;
};

function buildPrompt(input: StandaloneClaudeInput, systemPrompt?: string): string {
  const userPrompt = `From: ${input.from}\n\nUser message:\n${input.body || "(empty)"}`;
  if (!systemPrompt?.trim()) return userPrompt;
  return `${systemPrompt.trim()}\n\n${userPrompt}`;
}

function buildArgs(argsTemplate: string[], prompt: string): string[] {
  return argsTemplate.map((item) => item.replaceAll("{{prompt}}", prompt));
}

export function buildSessionArgs(argsTemplate: string[], opts: StandaloneClaudeSessionOptions): string[] {
  if (opts.mode === "sync") {
    return ["-p", "-r", opts.sessionId, "--fork-session", opts.prompt];
  }

  const hasPrintFlag = argsTemplate.includes("-p") || argsTemplate.includes("--print");
  const sessionFlag = opts.startNewSession ? "--session-id" : "-r";

  if (hasPrintFlag) {
    return [sessionFlag, opts.sessionId, ...buildArgs(argsTemplate, opts.prompt)];
  }

  return ["-p", sessionFlag, opts.sessionId, opts.prompt];
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

interface ClaudeOutput {
  text: string;
  toolSummaries: string[];
}

function parseClaudeOutput(output: string): ClaudeOutput {
  const trimmed = output.trim();
  if (!trimmed) return { text: "", toolSummaries: [] };
  try {
    const parsed = JSON.parse(trimmed) as {
      text?: string;
      content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }>;
    };
    const text = parsed.text || "";
    const toolSummaries: string[] = [];

    // Extract tool_use blocks from content array
    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (block.type === "tool_use" && block.name) {
          const input = block.input || {};
          let detail = "";
          if (block.name === "Write" && input.file_path) {
            detail = String(input.file_path);
          } else if (block.name === "Edit" && input.file_path) {
            detail = String(input.file_path);
          } else if (block.name === "Read" && input.file_path) {
            detail = String(input.file_path);
          }
          toolSummaries.push(detail ? `${block.name} ${detail}` : block.name);
        }
      }
    }

    return { text, toolSummaries };
  } catch {
    // plain text output path
    return { text: trimmed, toolSummaries: [] };
  }
}

async function execClaude(cfg: StandaloneClaudeConfig, args: string[]): Promise<ClaudeOutput> {
  const env = pickEnv(cfg.envAllowlist);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      cfg.command,
      args,
      {
        timeout: cfg.timeoutMs,
        maxBuffer: Math.max(cfg.maxOutputChars * 4, 64 * 1024),
        env,
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

export async function runStandaloneClaude(
  input: StandaloneClaudeInput,
  cfg: StandaloneClaudeConfig,
): Promise<ClaudeOutput> {
  const prompt = buildPrompt(input, cfg.systemPrompt);
  const args = buildArgs(cfg.argsTemplate, prompt);
  return execClaude(cfg, args);
}

// ---------------------------------------------------------------------------
// Session history management (in-memory, per session ID)
// ---------------------------------------------------------------------------

type Message = { role: "user" | "assistant"; content: string };

const sessionHistories = new Map<string, Message[]>();

export function getHistory(sessionId: string): Message[] {
  let history = sessionHistories.get(sessionId);
  if (!history) {
    history = [];
    sessionHistories.set(sessionId, history);
  }
  return history;
}

export function loadHistory(sessionId: string, messages: Message[]): void {
  sessionHistories.set(sessionId, [...messages]);
}

export function clearClaudeSession(sessionId: string): void {
  sessionHistories.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Run with session history (for desktop-imported sessions)
// ---------------------------------------------------------------------------

export async function runStandaloneClaudeSession(
  cfg: StandaloneClaudeConfig,
  opts: StandaloneClaudeSessionOptions,
): Promise<ClaudeOutput> {
  const history = getHistory(opts.sessionId);

  // Build prompt with history context (keep it compact)
  let fullPrompt = opts.prompt;
  if (history.length > 0) {
    const historyText = history
      .slice(-6) // last 3 pairs max to keep prompt short
      .map((m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`)
      .join("\n\n");
    fullPrompt = `Previous conversation:\n${historyText}\n\n---\n\nCurrent message:\n${opts.prompt}`;
  }

  // Always use -p (print) mode, no session flag — we manage history ourselves
  const args = ["-p", ...buildArgs(cfg.argsTemplate, fullPrompt)];
  const result = await execClaude(cfg, args);

  // Update session history
  history.push({ role: "user", content: opts.prompt });
  history.push({ role: "assistant", content: result.text });

  return result;
}
