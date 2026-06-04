/**
 * Agent backend abstraction.
 *
 * A backend wraps a local coding-agent CLI (Claude Code today; OpenCode and
 * others later) behind a uniform interface so the Weixin bridge can drive any
 * of them. Each backend owns its own session / resume semantics, so the bridge
 * only has to track an opaque session id and which backend produced it.
 */

export type AgentBackendConfig = {
  /** Executable command, e.g. "claude". */
  command: string;
  /** Per-turn timeout in ms. */
  timeoutMs: number;
  /** Hard cap on returned text length (characters). */
  maxOutputChars: number;
  /** Names of env vars forwarded to the child process (PATH is always kept). */
  envAllowlist: string[];
  /** Optional system prompt prepended to the agent's own. */
  systemPrompt?: string;
  /** Extra CLI args appended verbatim (model, permission mode, etc). */
  extraArgs?: string[];
};

export type AgentTurnInput = {
  /** Canonical session id we want the backend to use / resume. */
  sessionId: string;
  /** The user's message for this turn. */
  prompt: string;
  /** Working directory the agent should run in (project root). */
  cwd?: string;
  /** When true, create a fresh session; otherwise resume `sessionId`. */
  startNewSession: boolean;
};

export type AgentTurnResult = {
  text: string;
  toolSummaries: string[];
  /** Session id actually used by the backend; the caller must persist this. */
  sessionId: string;
  /** True when this turn created a new session (explicitly, or via resume fallback). */
  startedNewSession: boolean;
};

export interface AgentBackend {
  /** Stable identifier, e.g. "claude". */
  readonly name: string;
  /** Produce a fresh, backend-valid session id. */
  newSessionId(): string;
  /** Run a single conversational turn (create or resume). */
  runTurn(cfg: AgentBackendConfig, input: AgentTurnInput): Promise<AgentTurnResult>;
}

export const DEFAULT_BACKEND = "claude";

const registry = new Map<string, AgentBackend>();

export function registerBackend(backend: AgentBackend): void {
  registry.set(backend.name, backend);
}

export function getBackend(name?: string): AgentBackend {
  const key = name?.trim() || DEFAULT_BACKEND;
  const backend = registry.get(key);
  if (!backend) {
    throw new Error(`unknown agent backend: ${key}`);
  }
  return backend;
}

/** Test/runtime helper to inspect registered backend names. */
export function listBackends(): string[] {
  return Array.from(registry.keys());
}
