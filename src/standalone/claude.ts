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

export async function runStandaloneClaudeSession(
  cfg: StandaloneClaudeConfig,
  opts: StandaloneClaudeSessionOptions,
): Promise<string> {
  const args = buildSessionArgs(cfg.argsTemplate, opts);
  return execClaude(cfg, args);
}
