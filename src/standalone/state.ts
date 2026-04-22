import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StandaloneAccountState = {
  accountId: string;
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  userId?: string;
  updatedAt: string;
};

export type StandaloneRuntimeState = {
  getUpdatesBuf?: string;
};

function resolveStandaloneStateDir(): string {
  return process.env.CLAUDE_WEIXIN_STATE_DIR?.trim() || path.join(os.homedir(), ".claude-weixin");
}

function resolveAccountPath(): string {
  return path.join(resolveStandaloneStateDir(), "account.json");
}

function resolveRuntimePath(): string {
  return path.join(resolveStandaloneStateDir(), "runtime.json");
}

function ensureStateDir(): void {
  fs.mkdirSync(resolveStandaloneStateDir(), { recursive: true });
}

export function loadStandaloneAccountState(): StandaloneAccountState | null {
  try {
    const file = resolveAccountPath();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as StandaloneAccountState;
  } catch {
    return null;
  }
}

export function saveStandaloneAccountState(state: StandaloneAccountState): void {
  ensureStateDir();
  const file = resolveAccountPath();
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function loadStandaloneRuntimeState(): StandaloneRuntimeState {
  try {
    const file = resolveRuntimePath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as StandaloneRuntimeState;
  } catch {
    return {};
  }
}

export function saveStandaloneRuntimeState(state: StandaloneRuntimeState): void {
  ensureStateDir();
  const file = resolveRuntimePath();
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
}
