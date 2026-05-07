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

export type StandaloneSessionStatus = "active" | "archived";

export type StandaloneSessionState = {
  id: string;
  claudeSessionId: string;
  title: string;
  project?: string;
  status: StandaloneSessionStatus;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  initialized: boolean;
  lastUserText?: string;
  lastAssistantText?: string;
  /** "local" = created in Weixin, "desktop" = imported from ~/.claude/projects */
  source?: "local" | "desktop";
  /** Absolute path to the desktop session jsonl file (only for source=desktop) */
  desktopJsonlPath?: string;
  /** Original Claude session UUID (only for source=desktop) */
  desktopSessionId?: string;
};

export type StandaloneUserRuntimeState = {
  focusedProject?: string;
  focusedSessionId?: string;
  sessions: Record<string, StandaloneSessionState>;
  sessionOrder: string[];
};

export type StandaloneRuntimeState = {
  version: 1;
  getUpdatesBuf?: string;
  users: Record<string, StandaloneUserRuntimeState>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeSession(sessionId: string, raw: unknown): StandaloneSessionState | null {
  if (!isRecord(raw)) return null;

  const id = typeof raw.id === "string" && raw.id ? raw.id : sessionId;
  const claudeSessionId = typeof raw.claudeSessionId === "string" ? raw.claudeSessionId : "";
  if (!claudeSessionId) return null;

  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id;
  const project = typeof raw.project === "string" && raw.project.trim() ? raw.project.trim() : undefined;
  const status: StandaloneSessionStatus = raw.status === "archived" ? "archived" : "active";
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : createdAt;
  const turnCount = typeof raw.turnCount === "number" && Number.isFinite(raw.turnCount) && raw.turnCount >= 0
    ? Math.floor(raw.turnCount)
    : 0;
  const initialized = typeof raw.initialized === "boolean" ? raw.initialized : turnCount > 0;
  const lastUserText = typeof raw.lastUserText === "string" ? raw.lastUserText : undefined;
  const lastAssistantText = typeof raw.lastAssistantText === "string" ? raw.lastAssistantText : undefined;
  const source: "local" | "desktop" | undefined = raw.source === "desktop" ? "desktop" : (raw.source === "local" ? "local" : undefined);
  const desktopJsonlPath = typeof raw.desktopJsonlPath === "string" ? raw.desktopJsonlPath : undefined;
  const desktopSessionId = typeof raw.desktopSessionId === "string" ? raw.desktopSessionId : undefined;

  return {
    id,
    claudeSessionId,
    title,
    project,
    status,
    createdAt,
    updatedAt,
    turnCount,
    initialized,
    lastUserText,
    lastAssistantText,
    source,
    desktopJsonlPath,
    desktopSessionId,
  };
}

function normalizeUserRuntimeState(raw: unknown): StandaloneUserRuntimeState {
  if (!isRecord(raw)) {
    return { sessions: {}, sessionOrder: [] };
  }

  const sessions: Record<string, StandaloneSessionState> = {};
  const rawSessions = isRecord(raw.sessions) ? raw.sessions : {};

  for (const [sessionId, sessionRaw] of Object.entries(rawSessions)) {
    const normalized = normalizeSession(sessionId, sessionRaw);
    if (normalized) sessions[normalized.id] = normalized;
  }

  const sessionOrder = Array.isArray(raw.sessionOrder)
    ? raw.sessionOrder.filter((id): id is string => typeof id === "string" && Boolean(sessions[id]))
    : [];

  for (const sessionId of Object.keys(sessions)) {
    if (!sessionOrder.includes(sessionId)) {
      sessionOrder.push(sessionId);
    }
  }

  const focusedSessionId = typeof raw.focusedSessionId === "string" && sessions[raw.focusedSessionId]
    ? raw.focusedSessionId
    : undefined;
  const focusedProject = typeof raw.focusedProject === "string" && raw.focusedProject.trim()
    ? raw.focusedProject.trim()
    : (focusedSessionId ? sessions[focusedSessionId]?.project : undefined);

  return {
    focusedProject,
    focusedSessionId,
    sessions,
    sessionOrder,
  };
}

function normalizeRuntimeState(raw: unknown): StandaloneRuntimeState {
  if (!isRecord(raw)) {
    return {
      version: 1,
      users: {},
    };
  }

  const users: Record<string, StandaloneUserRuntimeState> = {};
  const rawUsers = isRecord(raw.users) ? raw.users : {};
  for (const [fromUserId, userRaw] of Object.entries(rawUsers)) {
    users[fromUserId] = normalizeUserRuntimeState(userRaw);
  }

  const getUpdatesBuf = typeof raw.getUpdatesBuf === "string" ? raw.getUpdatesBuf : undefined;

  return {
    version: 1,
    getUpdatesBuf,
    users,
  };
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
    if (!fs.existsSync(file)) {
      return {
        version: 1,
        users: {},
      };
    }
    const raw = fs.readFileSync(file, "utf-8");
    return normalizeRuntimeState(JSON.parse(raw));
  } catch {
    return {
      version: 1,
      users: {},
    };
  }
}

export function saveStandaloneRuntimeState(state: StandaloneRuntimeState): void {
  ensureStateDir();
  const file = resolveRuntimePath();
  fs.writeFileSync(file, JSON.stringify(normalizeRuntimeState(state), null, 2), "utf-8");
}
