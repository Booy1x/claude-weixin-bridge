import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ClaudeHistoryEntry = {
  display?: string;
  project?: string;
  sessionId?: string;
};

function resolveClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

function normalizeText(text?: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function isMeaningfulDisplay(display?: string): boolean {
  const text = normalizeText(display);
  return Boolean(text) && !text.startsWith("/") && !text.startsWith("!");
}

function readJsonl(filePath: string): unknown[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readCustomTitle(claudeDir: string, projectPath: string, sessionId?: string): string | null {
  if (!sessionId) return null;
  const projectKey = projectPath.split(path.sep).join("-");
  const sessionPath = path.join(claudeDir, "projects", projectKey, `${sessionId}.jsonl`);
  const rows = readJsonl(sessionPath);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const typed = row as { type?: string; customTitle?: string };
    if (typed.type === "custom-title" && normalizeText(typed.customTitle)) {
      return normalizeText(typed.customTitle);
    }
  }
  return null;
}

function truncateLine(text: string, max = 80): string {
  const clean = normalizeText(text);
  if (!clean) return "(空)";
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

export function buildRecentDesktopProjectSyncText(options?: {
  claudeDir?: string;
  excludeProject?: string;
}): string {
  const claudeDir = options?.claudeDir || resolveClaudeDir();
  const historyPath = path.join(claudeDir, "history.jsonl");
  const history = readJsonl(historyPath) as ClaudeHistoryEntry[];

  let recentProject: ClaudeHistoryEntry | null = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const project = normalizeText(entry?.project);
    if (!project) continue;
    if (options?.excludeProject && project === options.excludeProject) continue;
    recentProject = entry;
    break;
  }

  if (!recentProject?.project) {
    return [
      "最近项目: 暂无",
      "当前状态: 没找到电脑端项目记录",
      "下一步: 先在电脑端打开一个 Claude Code 项目",
    ].join("\n");
  }

  const projectPath = normalizeText(recentProject.project);
  const sessionId = normalizeText(recentProject.sessionId);
  let currentStatus = "";

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (normalizeText(entry?.project) !== projectPath) continue;
    if (sessionId && normalizeText(entry?.sessionId) !== sessionId) continue;
    if (!isMeaningfulDisplay(entry?.display)) continue;
    currentStatus = normalizeText(entry.display);
    break;
  }

  if (!currentStatus) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const entry = history[i];
      if (normalizeText(entry?.project) !== projectPath) continue;
      if (!isMeaningfulDisplay(entry?.display)) continue;
      currentStatus = normalizeText(entry.display);
      break;
    }
  }

  const projectName = readCustomTitle(claudeDir, projectPath, sessionId)
    || path.basename(projectPath)
    || projectPath;

  return [
    `最近项目: ${truncateLine(projectName, 60)}`,
    `当前状态: ${truncateLine(currentStatus || `最近打开了 ${projectName}`, 80)}`,
    `下一步: 回到电脑端继续 ${truncateLine(projectName, 60)}`,
  ].join("\n");
}
