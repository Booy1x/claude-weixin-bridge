import crypto from "node:crypto";
import fs from "node:fs";

import { startWeixinLoginWithQr, waitForWeixinLogin } from "../auth/login-qr.js";
import { getConfig, getUpdates, sendMessage, sendTyping } from "../api/api.js";
import { MessageItemType, MessageState, MessageType, TypingStatus, type MessageItem } from "../api/types.js";
import { generateId } from "../util/random.js";

import { runStandaloneClaudeSession, loadHistory, getHistory } from "./claude.js";
import { scanDesktopSessions, extractSessionHistory } from "./import-sessions.js";
import {
  type StandaloneRuntimeState,
  type StandaloneSessionState,
  type StandaloneUserRuntimeState,
  loadStandaloneAccountState,
  loadStandaloneRuntimeState,
  saveStandaloneAccountState,
  saveStandaloneRuntimeState,
} from "./state.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_REPLY_CHARS = 1200;
const MAX_SESSION_LIST = 8;

function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseEnvList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

type ParsedCommand =
  | { type: "list" }
  | { type: "switch"; target: string }
  | { type: "new"; project?: string; title: string }
  | { type: "import"; project?: string; limit: number }
  | { type: "clear" }
  | { type: "sync"; all: boolean }
  | { type: "projects" }
  | { type: "sessions" }
  | { type: "use"; target: string }
  | { type: "project"; target: string };

function parseCommand(rawBody: string): ParsedCommand | null {
  const body = rawBody.trim();
  if (!body.startsWith("/")) return null;

  const [headRaw, ...restParts] = body.split(/\s+/);
  const head = headRaw.toLowerCase();
  const rest = restParts.join(" ").trim();

  // / — 列出所有会话
  if (head === "/") {
    return { type: "list" };
  }

  // /1 /2 /3 ... — 按编号切换会话
  if (/^\/\d+$/.test(head)) {
    const idx = parseInt(head.slice(1), 10);
    if (idx >= 1) return { type: "switch", target: String(idx) };
  }

  // /new [项目] | 标题 — 创建新会话
  if (head === "/new") {
    if (!rest) return null;
    const sepIdx = rest.indexOf("|");
    if (sepIdx >= 0) {
      const project = rest.slice(0, sepIdx).trim();
      const title = rest.slice(sepIdx + 1).trim();
      if (!title) return null;
      return { type: "new", project: project || undefined, title };
    }
    return { type: "new", title: rest };
  }

  // /import [项目] [--limit N | --all] — 导入电脑端会话
  if (head === "/import") {
    let project: string | undefined;
    let limit = 10;
    if (rest) {
      if (rest.includes("--all")) {
        limit = 0;
      } else {
        const limitMatch = rest.match(/--limit\s+(\d+)/);
        if (limitMatch) {
          limit = Math.min(Math.max(parseInt(limitMatch[1], 10), 1), 30);
        }
      }
      const projectPart = rest.replace(/--limit\s+\d+/, "").replace(/--all/, "").trim();
      if (projectPart) project = projectPart;
    }
    return { type: "import" as const, project, limit };
  }

  // /clear — 清理电脑端导入的会话
  if (head === "/clear") {
    return { type: "clear" };
  }

  if (head === "/sync") {
    return { type: "sync", all: rest.toLowerCase() === "all" };
  }

  if (head === "/projects") {
    return { type: "projects" };
  }

  if (head === "/sessions") {
    return { type: "sessions" };
  }

  if (head === "/use") {
    if (!rest) return null;
    return { type: "use", target: rest };
  }

  if (head === "/project") {
    if (!rest) return null;
    return { type: "project", target: rest };
  }

  // /prj1 /domain 等 — 按项目名切换
  if (rest.length === 0) {
    return { type: "switch", target: head.slice(1) };
  }

  return null;
}

function truncateForCard(text: string | undefined, max = 80): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "(空)";
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function trimReplyText(text: string): string {
  const clean = text.trim();
  if (clean.length <= MAX_REPLY_CHARS) return clean;
  return `${clean.slice(0, MAX_REPLY_CHARS)}…`;
}

function getOrCreateUserRuntime(runtime: StandaloneRuntimeState, fromUserId: string): StandaloneUserRuntimeState {
  const existing = runtime.users[fromUserId];
  if (existing) return existing;
  const created: StandaloneUserRuntimeState = {
    sessions: {},
    sessionOrder: [],
  };
  runtime.users[fromUserId] = created;
  return created;
}

function createLocalSessionId(): string {
  return `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function createClaudeSessionId(): string {
  return crypto.randomUUID();
}

function touchSession(user: StandaloneUserRuntimeState, sessionId: string): void {
  const nextOrder = [sessionId, ...user.sessionOrder.filter((id) => id !== sessionId)];
  user.sessionOrder = nextOrder.slice(0, MAX_SESSION_LIST);
}

function syncFocusedProjectFromSession(user: StandaloneUserRuntimeState, session?: StandaloneSessionState): void {
  if (session?.project) {
    user.focusedProject = session.project;
  }
}

function ensureFocusedSession(user: StandaloneUserRuntimeState): StandaloneSessionState {
  const focused = user.focusedSessionId ? user.sessions[user.focusedSessionId] : undefined;
  if (focused) {
    syncFocusedProjectFromSession(user, focused);
    return focused;
  }

  const now = new Date().toISOString();
  const sessionId = createLocalSessionId();
  const created: StandaloneSessionState = {
    id: sessionId,
    claudeSessionId: createClaudeSessionId(),
    title: user.focusedProject ? `${user.focusedProject} inbox` : "inbox",
    project: user.focusedProject,
    status: "active",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    initialized: false,
  };
  user.sessions[sessionId] = created;
  user.focusedSessionId = sessionId;
  touchSession(user, sessionId);
  syncFocusedProjectFromSession(user, created);
  return created;
}

function createSession(user: StandaloneUserRuntimeState, params: { project?: string; title: string }): StandaloneSessionState {
  const now = new Date().toISOString();
  const sessionId = createLocalSessionId();
  const project = params.project?.trim() || user.focusedProject;
  const created: StandaloneSessionState = {
    id: sessionId,
    claudeSessionId: createClaudeSessionId(),
    title: params.title,
    project,
    status: "active",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    initialized: false,
  };
  user.sessions[sessionId] = created;
  user.focusedSessionId = sessionId;
  touchSession(user, sessionId);
  syncFocusedProjectFromSession(user, created);

  const overflow = user.sessionOrder.slice(MAX_SESSION_LIST);
  for (const oldSessionId of overflow) {
    delete user.sessions[oldSessionId];
  }
  user.sessionOrder = user.sessionOrder.slice(0, MAX_SESSION_LIST);

  return created;
}

function resolveSessionByTarget(user: StandaloneUserRuntimeState, targetRaw: string): StandaloneSessionState | null {
  const target = targetRaw.trim();
  if (!target) return null;

  const direct = user.sessions[target];
  if (direct) return direct;

  const asIndex = Number(target);
  if (Number.isInteger(asIndex) && asIndex > 0) {
    const sessionId = user.sessionOrder[asIndex - 1];
    if (sessionId && user.sessions[sessionId]) return user.sessions[sessionId];
  }

  const lower = target.toLowerCase();
  for (const sessionId of user.sessionOrder) {
    const session = user.sessions[sessionId];
    if (!session) continue;
    const title = session.title.toLowerCase();
    if (title.includes(lower)) return session;
  }

  return null;
}

function listProjects(user: StandaloneUserRuntimeState): Array<{ name: string; sessions: StandaloneSessionState[] }> {
  const map = new Map<string, StandaloneSessionState[]>();
  for (const sessionId of user.sessionOrder) {
    const session = user.sessions[sessionId];
    if (!session) continue;
    const project = session.project || "(未分组)";
    const group = map.get(project) || [];
    group.push(session);
    map.set(project, group);
  }
  return Array.from(map.entries()).map(([name, sessions]) => ({ name, sessions }));
}

function resolveProjectName(user: StandaloneUserRuntimeState, targetRaw: string): string | null {
  const target = targetRaw.trim();
  if (!target) return null;
  const groups = listProjects(user);
  const direct = groups.find((group) => group.name === target);
  if (direct) return direct.name;

  const asIndex = Number(target);
  if (Number.isInteger(asIndex) && asIndex > 0) {
    const group = groups[asIndex - 1];
    if (group) return group.name;
  }

  const lower = target.toLowerCase();
  const fuzzy = groups.find((group) => group.name.toLowerCase().includes(lower));
  return fuzzy?.name || null;
}

function switchFocusedProject(user: StandaloneUserRuntimeState, projectName: string): StandaloneSessionState | null {
  user.focusedProject = projectName === "(未分组)" ? undefined : projectName;
  for (const sessionId of user.sessionOrder) {
    const session = user.sessions[sessionId];
    if (!session) continue;
    const sessionProject = session.project || "(未分组)";
    if (sessionProject === projectName) {
      user.focusedSessionId = session.id;
      touchSession(user, session.id);
      return session;
    }
  }
  user.focusedSessionId = undefined;
  return null;
}

function updateSessionFromTurn(session: StandaloneSessionState, userText: string, assistantText: string): void {
  session.turnCount += 1;
  session.initialized = true;
  session.updatedAt = new Date().toISOString();
  session.lastUserText = truncateForCard(userText, 160);
  session.lastAssistantText = truncateForCard(assistantText, 160);
}

function formatSessionLine(index: number, session: StandaloneSessionState, focused: boolean): string {
  const prefix = focused ? "*" : " ";
  const project = session.project ? ` [${session.project}]` : "";
  return `${prefix}${index}. ${session.id}${project} ${session.title} (turns ${session.turnCount})`;
}

function buildSyncCardForSession(session: StandaloneSessionState): string {
  return trimReplyText([
    "[SYNC]",
    `项目: ${session.project || "(未设置)"}`,
    `状态: ${session.status === "active" ? "RUNNING" : "ARCHIVED"}`,
    `当前在做: ${truncateForCard(session.lastUserText || session.title, 100)}`,
    `做到哪: 已完成 ${session.turnCount} 轮`,
    `下一步: ${truncateForCard(session.lastAssistantText || "等待你的下一条消息", 100)}`,
    "你可以直接回复继续当前任务，或 /projects 切项目",
  ].join("\n"));
}

function buildSyncAllCard(user: StandaloneUserRuntimeState): string {
  const lines: string[] = ["[SYNC ALL]"];
  const groups = listProjects(user);
  if (groups.length === 0) {
    lines.push("暂无任务，先发普通消息或 /new <项目> | <标题> 创建。 ");
    return trimReplyText(lines.join("\n"));
  }

  lines.push(`项目数: ${groups.length}`);
  for (let i = 0; i < Math.min(groups.length, 5); i += 1) {
    const group = groups[i];
    const focused = (user.focusedProject || "(未分组)") === group.name ? "*" : " ";
    const current = group.sessions[0];
    lines.push(`${focused}${i + 1}. ${group.name} | ${group.sessions.length}个任务 | 当前: ${truncateForCard(current?.title, 32)}`);
  }
  lines.push("用 /project <编号> 切项目，直接回复继续当前任务。");
  return trimReplyText(lines.join("\n"));
}

const DESKTOP_IMPORT_PREFIX = "desktop-";

function handleImportCommand(userRuntime: StandaloneUserRuntimeState, opts: { project?: string; limit: number }): string {
  const allSessions = scanDesktopSessions();
  if (allSessions.length === 0) {
    return "未在 ~/.claude/projects/ 下找到任何会话。";
  }

  let filtered = allSessions;
  if (opts.project) {
    const keyword = opts.project.toLowerCase();
    filtered = allSessions.filter(
      (s) => s.projectName.toLowerCase().includes(keyword) || s.sessionId.toLowerCase().includes(keyword),
    );
    if (filtered.length === 0) {
      const projects = [...new Set(allSessions.map((s) => s.projectName))];
      return trimReplyText([
        `未找到匹配 "${opts.project}" 的项目。`,
        `可用项目: ${projects.slice(0, 5).join(", ")}${projects.length > 5 ? "..." : ""}`,
        "",
        "用法: /import [项目名] [--limit N] [--all]",
      ].join("\n"));
    }
  }

  const alreadyImported = Object.values(userRuntime.sessions).filter(
    (s) => s.source === "desktop",
  ).length;

  const candidates = filtered.filter(
    (ds) => !Object.values(userRuntime.sessions).some(
      (s) => s.source === "desktop" && s.desktopSessionId === ds.sessionId,
    ),
  );

  const toImportCount = opts.limit <= 0 ? candidates.length : Math.min(opts.limit, candidates.length);
  const toImport = candidates.slice(0, toImportCount);
  const now = new Date().toISOString();

  // Insert new sessions right after current focused session (or at front if none)
  const focusedIdx = userRuntime.focusedSessionId
    ? userRuntime.sessionOrder.indexOf(userRuntime.focusedSessionId)
    : -1;
  const insertAt = focusedIdx >= 0 ? focusedIdx + 1 : 0;

  for (let i = 0; i < toImport.length; i++) {
    const ds = toImport[i];
    const localId = `${DESKTOP_IMPORT_PREFIX}${ds.sessionId.slice(0, 12)}`;
    const session: StandaloneSessionState = {
      id: localId,
      claudeSessionId: ds.sessionId,
      title: ds.firstPrompt,
      project: ds.projectName,
      status: "active",
      createdAt: now,
      updatedAt: now,
      turnCount: ds.userTurnCount,
      initialized: ds.userTurnCount > 0,
      lastUserText: ds.lastPrompt.length > 80 ? `${ds.lastPrompt.slice(0, 80)}…` : ds.lastPrompt,
      lastAssistantText: undefined,
      source: "desktop",
      desktopJsonlPath: ds.jsonlPath,
      desktopSessionId: ds.sessionId,
    };

    userRuntime.sessions[localId] = session;
    // Insert after focused session so /1 picks up the first imported one
    userRuntime.sessionOrder.splice(insertAt + i, 0, localId);
  }

  // Auto-switch to first imported session
  const firstImportedId = `${DESKTOP_IMPORT_PREFIX}${toImport[0].sessionId.slice(0, 12)}`;
  userRuntime.focusedSessionId = firstImportedId;
  const switchedSession = userRuntime.sessions[firstImportedId];

  // Build summary grouped by project
  const projectMap = new Map<string, typeof toImport>();
  for (const ds of toImport) {
    const p = ds.projectName ? ds.projectName.split("/").pop() || "(unknown)" : "(unknown)";
    const group = projectMap.get(p) || [];
    group.push(ds);
    projectMap.set(p, group);
  }

  const summaryLines: string[] = [];
  let idx = 0;
  for (const [project, items] of projectMap) {
    summaryLines.push(`[${project}]`);
    for (const ds of items) {
      idx++;
      const t = ds.firstPrompt.length > 30 ? ds.firstPrompt.slice(0, 30) + "…" : ds.firstPrompt;
      summaryLines.push(`${idx}. ${t}`);
    }
    summaryLines.push("");
  }

  const moreLine = toImport.length > 10 ? `...还有 ${toImport.length - 10} 个` : "";
  const filterLabel = opts.project ? ` (项目: ${opts.project})` : "";
  const totalDesktop = Object.values(userRuntime.sessions).filter((s) => s.source === "desktop").length;
  const remaining = candidates.length - toImport.length;

  return [
    `[IMPORT]${filterLabel} 导入 ${toImport.length} 个，已导入 ${totalDesktop} 个，还可导入 ${remaining} 个`,
    "",
    `▸ 已切换到: ${switchedSession?.title?.slice(0, 40) || "(unknown)"}`,
    "",
    ...summaryLines,
    moreLine,
    "/ 查看列表，/编号 切换其他",
  ].join("\n");
}

function handleSwitchAndLoadContext(userRuntime: StandaloneUserRuntimeState, target: StandaloneSessionState): string {
  userRuntime.focusedSessionId = target.id;
  touchSession(userRuntime, target.id);
  syncFocusedProjectFromSession(userRuntime, target);

  let contextInfo = "";
  if (target.source === "desktop" && target.desktopJsonlPath) {
    const history = extractSessionHistory(target.desktopJsonlPath, 5, 1000);
    console.log(`[CONTEXT] session=${target.id} claudeSessionId=${target.claudeSessionId} history=${history.length} msgs`);
    if (history.length > 0) {
      loadHistory(target.claudeSessionId, history);
      const loaded = getHistory(target.claudeSessionId);
      console.log(`[CONTEXT] loaded=${loaded.length} msgs for session=${target.claudeSessionId}`);
      contextInfo = ` (已加载 ${history.length} 条历史消息)`;
    } else {
      contextInfo = " (历史消息为空，将作为新对话)";
    }
  }

  const sourceLabel = target.source === "desktop" ? "📎电脑端" : "📱微信端";
  const lines = [
    "已切换。",
    sourceLabel + contextInfo,
    `项目: ${target.project || "(未设置)"}`,
    `任务: ${target.title}`,
    `已对话 ${target.turnCount} 轮`,
  ];
  if (target.lastUserText) {
    lines.push(`最近: ${target.lastUserText}`);
  }
  if (target.source === "desktop") {
    lines.push("直接回复继续，上下文已同步。");
  }

  return trimReplyText(lines.join("\n"));
}

function buildSessionsListCard(user: StandaloneUserRuntimeState): string {
  const lines: string[] = ["[任务列表]"];
  const totalCount = user.sessionOrder.length;

  if (totalCount === 0) {
    lines.push("暂无任务。用 /new <标题> 创建，或 /import 导入电脑端会话。");
    return trimReplyText(lines.join("\n"));
  }

  // Build flat list with global indices (matching /1 /2 /3 ...)
  // Then group by project for display, but keep original indices
  const items: Array<{ id: string; session: StandaloneSessionState; globalIdx: number; isDesktop: boolean }> = [];
  for (let i = 0; i < user.sessionOrder.length; i++) {
    const id = user.sessionOrder[i];
    const s = user.sessions[id];
    if (!s) continue;
    items.push({ id, session: s, globalIdx: i + 1, isDesktop: s.source === "desktop" });
  }

  const desktopItems = items.filter(x => x.isDesktop);
  const localItems = items.filter(x => !x.isDesktop);

  if (desktopItems.length > 0) {
    lines.push("", `📎 电脑端 (${desktopItems.length}个)：`);
    // Group by project for display
    const projectMap = new Map<string, typeof desktopItems>();
    for (const item of desktopItems) {
      const p = item.session.project ? item.session.project.split("/").pop() || "(unknown)" : "(unknown)";
      const group = projectMap.get(p) || [];
      group.push(item);
      projectMap.set(p, group);
    }
    for (const [project, groupItems] of projectMap) {
      lines.push(`[${project}]`);
      for (const item of groupItems) {
        const focused = user.focusedSessionId === item.id;
        const prefix = focused ? "▸" : " ";
        const title = item.session.title.length > 30 ? `${item.session.title.slice(0, 30)}…` : item.session.title;
        lines.push(`${prefix}${item.globalIdx}. ${title}`);
      }
      lines.push("");
    }
  }

  if (localItems.length > 0) {
    lines.push(`📱 微信端 (${localItems.length}个)：`);
    for (const item of localItems) {
      const focused = user.focusedSessionId === item.id;
      const prefix = focused ? "▸" : " ";
      const title = item.session.title.length > 30 ? `${item.session.title.slice(0, 30)}…` : item.session.title;
      lines.push(`${prefix}${item.globalIdx}. ${title}`);
    }
    lines.push("");
  }

  lines.push("/ 查看，/编号 切换，/new 创建，/clear 清理");
  return trimReplyText(lines.join("\n"));
}

function handleClearCommand(userRuntime: StandaloneUserRuntimeState): string {
  let removed = 0;
  for (const [id, session] of Object.entries(userRuntime.sessions)) {
    if (session.source === "desktop") {
      delete userRuntime.sessions[id];
      removed++;
    }
  }
  userRuntime.sessionOrder = userRuntime.sessionOrder.filter((id) => userRuntime.sessions[id] !== undefined);

  if (userRuntime.focusedSessionId && !userRuntime.sessions[userRuntime.focusedSessionId]) {
    userRuntime.focusedSessionId = undefined;
  }

  return "已清理 " + removed + " 个电脑端导入的会话。当前剩余 " + userRuntime.sessionOrder.length + " 个。";
}

function buildProjectsCard(user: StandaloneUserRuntimeState): string {
  const lines: string[] = ["[PROJECTS]"];
  const groups = listProjects(user);
  if (groups.length === 0) {
    lines.push("暂无项目。可直接发消息开始，或 /new <项目> | <标题>。\n");
    return trimReplyText(lines.join("\n"));
  }

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const focused = (user.focusedProject || "(未分组)") === group.name ? "*" : " ";
    lines.push(`${focused}${i + 1}. ${group.name} (${group.sessions.length}个任务)`);
  }
  lines.push("* 表示当前项目；用 /project <编号> 切换。 ");
  return trimReplyText(lines.join("\n"));
}

function buildSessionsCard(user: StandaloneUserRuntimeState): string {
  const lines: string[] = ["[TASKS]"];
  const focusedProject = user.focusedProject;
  const ids = user.sessionOrder.filter((id) => {
    const session = user.sessions[id];
    if (!session) return false;
    if (!focusedProject) return true;
    return session.project === focusedProject;
  }).slice(0, MAX_SESSION_LIST);

  if (ids.length === 0) {
    lines.push(`当前项目 ${focusedProject || "(未分组)"} 暂无任务。可直接发消息继续，或 /new <标题>。`);
    return trimReplyText(lines.join("\n"));
  }

  lines.push(`当前项目: ${focusedProject || "(未分组)"}`);
  for (let i = 0; i < ids.length; i += 1) {
    const session = user.sessions[ids[i]];
    if (!session) continue;
    lines.push(formatSessionLine(i + 1, session, user.focusedSessionId === session.id));
  }
  lines.push("* 表示当前任务；直接回复会继续当前任务。 ");
  return trimReplyText(lines.join("\n"));
}

function buildSyncPrompt(session: StandaloneSessionState): string {
  return [
    "请用简洁中文返回 5 行以内同步卡片，不要输出工具细节。",
    `会话标题: ${session.title}`,
    `项目: ${session.project || "(未设置)"}`,
    `最近用户输入: ${session.lastUserText || "(暂无)"}`,
    `最近助手输出: ${session.lastAssistantText || "(暂无)"}`,
    `当前轮次: ${session.turnCount}`,
  ].join("\n");
}

async function cmdLogin(): Promise<void> {
  const start = await startWeixinLoginWithQr({ apiBaseUrl: DEFAULT_BASE_URL });
  if (!start.qrcodeUrl) {
    throw new Error(start.message || "failed to start login");
  }

  console.log("请扫码登录：");
  console.log(start.qrcodeUrl);

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    timeoutMs: 8 * 60_000,
  });

  if (!wait.connected || !wait.botToken || !wait.accountId) {
    throw new Error(wait.message || "login failed");
  }

  saveStandaloneAccountState({
    accountId: wait.accountId,
    token: wait.botToken,
    baseUrl: wait.baseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: DEFAULT_CDN_BASE_URL,
    userId: wait.userId,
    updatedAt: new Date().toISOString(),
  });

  console.log(`登录成功，accountId=${wait.accountId}`);
}

async function cmdRun(): Promise<void> {
  const account = loadStandaloneAccountState();
  if (!account?.token) {
    throw new Error("未找到登录信息，请先运行: npm run standalone:login");
  }

  let runtime = loadStandaloneRuntimeState();
  let getUpdatesBuf = runtime.getUpdatesBuf ?? "";

  const claudeCfg = {
    command: process.env.CLAUDE_CMD?.trim() || "claude",
    argsTemplate: parseEnvList("CLAUDE_ARGS", ["-p", "{{prompt}}"]),
    timeoutMs: parseEnvNumber("CLAUDE_TIMEOUT_MS", 120_000),
    maxOutputChars: parseEnvNumber("CLAUDE_MAX_OUTPUT_CHARS", 4000),
    envAllowlist: parseEnvList("CLAUDE_ENV_ALLOWLIST", ["ANTHROPIC_API_KEY"]),
    systemPrompt: process.env.CLAUDE_SYSTEM_PROMPT?.trim(),
  };

  const allowFromSet = new Set(
    parseEnvList("WEIXIN_ALLOW_FROM", []).map((v) => v.trim()).filter(Boolean),
  );

  console.log(`开始轮询微信消息，accountId=${account.accountId}`);

  while (true) {
    try {
      const updates = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: getUpdatesBuf,
      });

      if (updates.get_updates_buf && updates.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = updates.get_updates_buf;
        runtime = { ...runtime, getUpdatesBuf };
        saveStandaloneRuntimeState(runtime);
      }

      const msgs = updates.msgs ?? [];
      for (const msg of msgs) {
        const from = msg.from_user_id ?? "";
        if (!from) continue;
        if (allowFromSet.size > 0 && !allowFromSet.has(from)) continue;

        const body = extractTextBody(msg.item_list).trim();
        if (!body) continue;

        try {
          const contextToken = msg.context_token;
          let typingTicket = "";
          try {
            const cfg = await getConfig({
              baseUrl: account.baseUrl,
              token: account.token,
              ilinkUserId: from,
              contextToken,
            });
            typingTicket = cfg.typing_ticket ?? "";
          } catch {
            // ignore
          }

          if (typingTicket) {
            await sendTyping({
              baseUrl: account.baseUrl,
              token: account.token,
              body: {
                ilink_user_id: from,
                typing_ticket: typingTicket,
                status: TypingStatus.TYPING,
              },
            });
          }

          runtime = loadStandaloneRuntimeState();
          const userRuntime = getOrCreateUserRuntime(runtime, from);
          let replyText = "";

          const command = parseCommand(body);
          if (command?.type === "list") {
            replyText = buildSessionsListCard(userRuntime);
          } else if (command?.type === "switch") {
            const target = resolveSessionByTarget(userRuntime, command.target);
            if (!target) {
              replyText = "未找到: " + command.target;
            } else {
              replyText = handleSwitchAndLoadContext(userRuntime, target);
            }
          } else if (command?.type === "new") {
            const created = createSession(userRuntime, {
              project: command.project,
              title: command.title,
            });
            replyText = trimReplyText([
              "已创建并切到当前任务。",
              `项目: ${created.project || "(未设置)"}`,
              `任务: ${created.title}`,
              `编号: ${created.id}`,
            ].join("\n"));
          } else if (command?.type === "project") {
            const projectName = resolveProjectName(userRuntime, command.target);
            if (!projectName) {
              replyText = `未找到项目: ${command.target}`;
            } else {
              const session = switchFocusedProject(userRuntime, projectName);
              replyText = trimReplyText([
                "已切换当前项目。",
                `项目: ${projectName}`,
                `当前任务: ${session?.title || "暂无，直接发消息会新建任务"}`,
              ].join("\n"));
            }
          } else if (command?.type === "use") {
            const target = resolveSessionByTarget(userRuntime, command.target);
            if (!target) {
              replyText = `未找到任务: ${command.target}`;
            } else {
              userRuntime.focusedSessionId = target.id;
              touchSession(userRuntime, target.id);
              syncFocusedProjectFromSession(userRuntime, target);
              replyText = trimReplyText([
                "已切换当前任务。",
                `项目: ${target.project || "(未设置)"}`,
                `任务: ${target.title}`,
              ].join("\n"));
            }
          } else if (command?.type === "import") {
            replyText = handleImportCommand(userRuntime, { project: command.project, limit: command.limit });
          } else if (command?.type === "clear") {
            replyText = handleClearCommand(userRuntime);
          } else if (command?.type === "sync" && command.all) {
            replyText = buildSyncAllCard(userRuntime);
          } else {
            const session = ensureFocusedSession(userRuntime);
            touchSession(userRuntime, session.id);
            syncFocusedProjectFromSession(userRuntime, session);

            if (command?.type === "sync") {
              try {
                const result = await runStandaloneClaudeSession(claudeCfg, {
                  mode: "sync",
                  sessionId: session.claudeSessionId,
                  prompt: buildSyncPrompt(session),
                });
                replyText = trimReplyText(result.text || buildSyncCardForSession(session));
              } catch {
                replyText = buildSyncCardForSession(session);
              }
            } else {
              let toolSummaries: string[] = [];
              try {
                const result = await runStandaloneClaudeSession(claudeCfg, {
                  mode: "chat",
                  sessionId: session.claudeSessionId,
                  prompt: body,
                });
                replyText = result.text;
                toolSummaries = result.toolSummaries;
              } catch (err) {
                replyText = `Claude 调用失败: ${String(err)}`;
              }
              updateSessionFromTurn(session, body, replyText);

              // Append file change summary to reply
              if (toolSummaries.length > 0) {
                const summary = toolSummaries.map(s => `✅ ${s}`).join("\n");
                replyText = `${replyText}\n\n---\n${summary}`;
              }
            }

            // Sync conversation to desktop jsonl (raw text only, no tool summary suffix)
            if (session.source === "desktop" && session.desktopJsonlPath) {
              try {
                const timestamp = new Date().toISOString();
                const userEntry = JSON.stringify({
                  type: "user",
                  message: { role: "user", content: body },
                  timestamp,
                });
                // Strip tool summary suffix before writing to jsonl
                const cleanReply = replyText.replace(/\n\n---\n(✅ .+\n?)+$/, "");
                const asstEntry = JSON.stringify({
                  type: "assistant",
                  message: { role: "assistant", content: cleanReply },
                  timestamp,
                });
                fs.appendFileSync(session.desktopJsonlPath, `\n${userEntry}\n${asstEntry}`, "utf-8");
              } catch (syncErr) {
                console.error(`[SYNC] failed to write jsonl: ${String(syncErr)}`);
              }
            }
          }

          saveStandaloneRuntimeState(runtime);

          if (typingTicket) {
            await sendTyping({
              baseUrl: account.baseUrl,
              token: account.token,
              body: {
                ilink_user_id: from,
                typing_ticket: typingTicket,
                status: TypingStatus.CANCEL,
              },
            });
          }

          await sendMessage({
            baseUrl: account.baseUrl,
            token: account.token,
            body: {
              msg: {
                from_user_id: "",
                to_user_id: from,
                client_id: generateId("claude-weixin"),
                message_type: MessageType.BOT,
                message_state: MessageState.FINISH,
                context_token: contextToken,
                item_list: [{ type: MessageItemType.TEXT, text_item: { text: replyText } }],
              },
            },
          });
        } catch (msgErr) {
          console.error(`处理单条消息失败: ${String(msgErr)}`);
        }
      }
    } catch (loopErr) {
      console.error(`轮询异常，2秒后重试: ${String(loopErr)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]?.trim();
  const wantsHelp = process.argv.some((arg) => arg === "--help" || arg === "-h");
  if (wantsHelp || !cmd || (cmd !== "login" && cmd !== "run")) {
    console.log("用法: tsx src/standalone/run.ts <login|run>");
    console.log("  login  扫码登录并保存 token 到本地状态文件");
    console.log("  run    启动轮询并调用 Claude CLI 自动回复");
    return;
  }

  if (cmd === "login") {
    await cmdLogin();
    return;
  }

  await cmdRun();
}

void main();
