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

function parseClaudeOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { text?: string };
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // plain text output path
  }
  return trimmed;
}

async function execClaude(cfg: StandaloneClaudeConfig, args: string[]): Promise<string> {
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

  const text = parseClaudeOutput(stdout);
  return text.length > cfg.maxOutputChars ? text.slice(0, cfg.maxOutputChars) : text;
}

export async function runStandaloneClaude(
  input: StandaloneClaudeInput,
  cfg: StandaloneClaudeConfig,
): Promise<string> {
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
): Promise<string> {
  const history = getHistory(opts.sessionId);

  // Build prompt with history context
  const historyText = history
    .map((m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`)
    .join("\n\n");

  let fullPrompt: string;
  if (historyText) {
    fullPrompt = `Previous conversation:\n${historyText}\n\n---\n\nCurrent message:\n${opts.prompt}`;
  } else {
    fullPrompt = opts.prompt;
  }

  const args = buildSessionArgs(cfg.argsTemplate, { ...opts, prompt: fullPrompt });
  const text = await execClaude(cfg, args);

  // Update session history
  history.push({ role: "user", content: opts.prompt });
  history.push({ role: "assistant", content: text });

  return text;
}
