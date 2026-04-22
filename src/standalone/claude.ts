import { execFile } from "node:child_process";

export type StandaloneClaudeInput = {
  from: string;
  body: string;
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

export async function runStandaloneClaude(
  input: StandaloneClaudeInput,
  cfg: StandaloneClaudeConfig,
): Promise<string> {
  const prompt = buildPrompt(input, cfg.systemPrompt);
  const args = buildArgs(cfg.argsTemplate, prompt);
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
