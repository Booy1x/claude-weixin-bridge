/**
 * Sender authorization for the bridge.
 *
 * The bridge runs `claude` (and writes/reads files, runs commands) on the host,
 * so an unauthenticated sender is effectively remote code execution. Default to
 * locking access to the logged-in owner; only fall back to "allow everyone"
 * when we genuinely cannot identify anyone (and warn loudly).
 */

const ALLOW_ALL_TOKEN = "*";

export type Allowlist = {
  /** Allowed sender ids (empty when allowAll is true). */
  allowed: Set<string>;
  /** When true, every sender is allowed. */
  allowAll: boolean;
  /** Why access is open ("explicit" via `*`, or "unconfigured"), if allowAll. */
  openReason?: "explicit" | "unconfigured";
};

/**
 * Resolve the effective allowlist from `WEIXIN_ALLOW_FROM` entries plus the
 * logged-in owner id.
 *
 * - `*` in the env list explicitly opts into allow-all.
 * - The owner id is always allowed when known.
 * - With neither an owner nor any env entry, access is open (unconfigured) so a
 *   first-time setup is not silently broken — callers should warn.
 */
export function resolveAllowlist(envEntries: string[], ownerUserId?: string): Allowlist {
  const cleaned = envEntries.map((v) => v.trim()).filter(Boolean);
  if (cleaned.includes(ALLOW_ALL_TOKEN)) {
    return { allowed: new Set(), allowAll: true, openReason: "explicit" };
  }

  const allowed = new Set(cleaned);
  const owner = ownerUserId?.trim();
  if (owner) allowed.add(owner);

  if (allowed.size === 0) {
    return { allowed, allowAll: true, openReason: "unconfigured" };
  }
  return { allowed, allowAll: false };
}

export function isSenderAllowed(list: Allowlist, senderId: string): boolean {
  if (list.allowAll) return true;
  return list.allowed.has(senderId);
}

/** Permission modes accepted by the Claude CLI `--permission-mode` flag. */
export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export function isValidPermissionMode(mode: string): mode is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode);
}
