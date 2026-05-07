import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DesktopSessionInfo = {
  sessionId: string;
  projectPath: string;
  projectName: string;
  jsonlPath: string;
  /** First meaningful user message as summary */
  firstPrompt: string;
  /** Last user message as recent context */
  lastPrompt: string;
  /** Total user turn count */
  userTurnCount: number;
  lastActivity: string;
};

type JsonlEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  timestamp?: string;
  customTitle?: string;
};

function extractTextContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join(" ");
}

function isMeaningfulPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("<local-command")) return false;
  if (trimmed.startsWith("<command-")) return false;
  if (trimmed.startsWith("User request:")) return false;
  return true;
}

function getSessionTitle(jsonlPath: string, firstPrompt: string): string {
  try {
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        if (entry.type === "custom-title" && entry.customTitle?.trim()) {
          return entry.customTitle.trim();
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  // Fallback: use first meaningful prompt truncated
  if (firstPrompt) {
    const truncated = firstPrompt.length > 40 ? `${firstPrompt.slice(0, 40)}…` : firstPrompt;
    return truncated;
  }
  return "未命名会话";
}

function scanSessionFile(jsonlPath: string, projectPath: string, projectName: string): DesktopSessionInfo | null {
  try {
    if (!fs.existsSync(jsonlPath)) return null;
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const sessionId = path.basename(jsonlPath, ".jsonl");
    let firstPrompt = "";
    let lastPrompt = "";
    let userTurnCount = 0;
    let lastActivity = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        if (entry.type === "user" && entry.message?.role === "user") {
          const text = extractTextContent(entry.message.content);
          if (isMeaningfulPrompt(text)) {
            if (!firstPrompt) firstPrompt = text;
            lastPrompt = text;
            userTurnCount++;
          }
          if (entry.timestamp) lastActivity = entry.timestamp;
        }
      } catch {
        // skip
      }
    }

    if (userTurnCount === 0) return null;

    const title = getSessionTitle(jsonlPath, firstPrompt);

    return {
      sessionId,
      projectPath,
      projectName,
      jsonlPath,
      firstPrompt: title,
      lastPrompt: lastPrompt || firstPrompt,
      userTurnCount,
      lastActivity: lastActivity || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Check if text content is noise that should be skipped.
 */
function isNoisyContent(text: string): boolean {
  if (text.startsWith("<local-command")) return true;
  if (text.startsWith("<command-")) return true;
  if (text.startsWith("User request:")) return true;
  if (text.startsWith("{") && text.includes('"hookSpecificOutput"')) return true;
  return false;
}

/**
 * Extract the full conversation history from a desktop session .jsonl file.
 * Returns messages in order, suitable for seeding sessionHistories.
 *
 * Strategy:
 * - `type: "message"` entries are complete assistant responses (preferred).
 * - `type: "assistant"` entries are incremental streaming deltas; consecutive
 *   assistant deltas are merged into one message to avoid sending multiple
 *   assistant rows to the Anthropic API (which requires strict user/assistant
 *   alternation).
 * - `type: "user"` entries are user messages (filtered for noise).
 */
export function extractSessionHistory(jsonlPath: string, maxPairs = 5, maxChars = 1000): ConversationMessage[] {
  interface RawTurn {
    role: "user" | "assistant";
    text: string;
  }

  const turns: RawTurn[] = [];
  try {
    if (!fs.existsSync(jsonlPath)) return [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);

    let pendingAssistantText = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        if (!entry.message?.role) continue;

        const etype = entry.type;

        if (etype === "user") {
          const text = extractTextContent(entry.message.content);
          const trimmed = text.trim();
          // Skip empty or noisy user messages without flushing pending assistant
          if (!trimmed || isNoisyContent(trimmed)) continue;

          // Only flush accumulated assistant text when we have a real user message
          if (pendingAssistantText.trim()) {
            turns.push({ role: "assistant", text: pendingAssistantText });
            pendingAssistantText = "";
          }

          turns.push({ role: "user", text: trimmed });
        } else if (etype === "message") {
          // Complete assistant response — merge with any pending delta
          const text = extractTextContent(entry.message.content);
          const trimmed = text.trim();
          if (!trimmed) {
            // Even if message is empty, flush pending delta
            if (pendingAssistantText.trim()) {
              turns.push({ role: "assistant", text: pendingAssistantText });
              pendingAssistantText = "";
            }
            continue;
          }

          const merged = pendingAssistantText.trim()
            ? `${pendingAssistantText}\n${trimmed}`
            : trimmed;
          pendingAssistantText = "";
          turns.push({ role: "assistant", text: merged });
        } else if (etype === "assistant") {
          // Streaming delta — accumulate text fragments
          const text = extractTextContent(entry.message.content);
          const trimmed = text.trim();
          if (!trimmed) continue;

          pendingAssistantText = pendingAssistantText
            ? `${pendingAssistantText}\n${trimmed}`
            : trimmed;
        }
        // Skip all other types (attachment, system, etc.)
      } catch {
        // skip malformed lines
      }
    }

    // Flush remaining assistant text
    if (pendingAssistantText.trim()) {
      turns.push({ role: "assistant", text: pendingAssistantText });
    }
  } catch {
    // skip unreadable files
  }

  // Truncate to the last N user messages (and their assistant replies).
  // Count user messages from the end to determine the cutoff.
  let userCount = 0;
  let startIdx = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      userCount++;
      if (userCount >= maxPairs) {
        startIdx = i;
        break;
      }
    }
  }

  const truncated = turns.slice(startIdx).map((t) => ({
    role: t.role,
    content: t.text.length > maxChars ? `${t.text.slice(0, maxChars)}…` : t.text,
  }));

  // Ensure the message list starts with user role (Anthropic API requirement)
  const firstUserIdx = truncated.findIndex((m) => m.role === "user");
  if (firstUserIdx > 0) {
    return truncated.slice(firstUserIdx);
  } else if (firstUserIdx === -1) {
    return [];
  }

  return truncated;
}

export function scanDesktopSessions(claudeDir?: string): DesktopSessionInfo[] {
  const dir = claudeDir || path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(dir)) return [];

  const sessions: DesktopSessionInfo[] = [];
  const projectDirs = fs.readdirSync(dir);

  for (const projectDir of projectDirs) {
    const projectPath = path.join(dir, projectDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(projectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Decode project path from Claude's directory naming (slashes -> dashes)
    // e.g. "-home-booy1x-project-prj1" -> "/home/booy1x/project/prj1"
    const decoded = projectDir.replace(/^-/, "").replace(/-/g, "/");
    const projectName = decoded.startsWith("/") ? decoded : "/" + decoded;
    const resolvedProjectPath = projectName;
    // For display, extract the project name from the encoded dir name
    // Claude Code encodes paths by replacing "/" with "-"
    // e.g. "-home-booy1x-project-domain-email" for "/home/booy1x/project/domain-email"
    // The project name is the last path segment, which may contain hyphens
    const dirParts = projectDir.replace(/^-/, "").split("-");
    const last1 = dirParts[dirParts.length - 1];
    const last2 = dirParts.slice(-2).join("-");
    // Heuristic rules for extracting project name from encoded dir name:
    // 1. If last1 is short (<= 4 chars), it's likely a project name like "prj1", "zupu"
    // 2. If last2 contains a hyphen and neither part is a common path component, use last2 (e.g., "domain-email")
    // 3. If last1 is a common component (like "project"), use the segment before it
    // 4. Otherwise, use last1
    const commonComponents = new Set(["home", "project", "workspace", "src", "lib", "test"]);
    const secondLast = dirParts.length >= 2 ? dirParts[dirParts.length - 2] : "";
    let displayProject: string;
    if (last1.length <= 4) {
      displayProject = last1;
    } else if (last2.includes("-") && !commonComponents.has(last1) && !commonComponents.has(secondLast)) {
      displayProject = last2;
    } else if (commonComponents.has(last1) && secondLast) {
      displayProject = secondLast;
    } else {
      displayProject = last1;
    }

    const files = fs.readdirSync(projectPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const jsonlPath = path.join(projectPath, file);
      const info = scanSessionFile(jsonlPath, resolvedProjectPath, displayProject);
      if (info) sessions.push(info);
    }
  }

  // Sort by last activity descending (most recent first)
  sessions.sort((a, b) => {
    const ta = new Date(a.lastActivity).getTime() || 0;
    const tb = new Date(b.lastActivity).getTime() || 0;
    return tb - ta;
  });

  return sessions;
}
