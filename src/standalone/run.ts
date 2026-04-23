import crypto from "node:crypto";

import { startWeixinLoginWithQr, waitForWeixinLogin } from "../auth/login-qr.js";
import { getConfig, getUpdates, sendMessage, sendTyping } from "../api/api.js";
import { MessageItemType, MessageState, MessageType, TypingStatus, type MessageItem } from "../api/types.js";
import { generateId } from "../util/random.js";

import { runStandaloneClaudeSession } from "./claude.js";
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
  | { type: "sync"; all: boolean }
  | { type: "sessions" }
  | { type: "new"; project?: string; title: string }
  | { type: "use"; target: string };

function parseCommand(rawBody: string): ParsedCommand | null {
  const body = rawBody.trim();
  if (!body.startsWith("/")) return null;

  const [headRaw, ...restParts] = body.split(/\s+/);
  const head = headRaw.toLowerCase();
  const rest = restParts.join(" ").trim();

  if (head === "/sync") {
    return { type: "sync", all: rest.toLowerCase() === "all" };
  }

  if (head === "/sessions") {
    return { type: "sessions" };
  }

  if (head === "/new") {
    if (!rest) return null;
    const sepIdx = rest.indexOf("|");
    if (sepIdx >= 0) {
      const project = rest.slice(0, sepIdx).trim();
      const title = rest.slice(sepIdx + 1).trim();
      if (!title) return null;
      return {
        type: "new",
        project: project || undefined,
        title,
      };
    }
    return {
      type: "new",
      title: rest,
    };
  }

  if (head === "/use") {
    if (!rest) return null;
    return { type: "use", target: rest };
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

function ensureFocusedSession(user: StandaloneUserRuntimeState): StandaloneSessionState {
  const focused = user.focusedSessionId ? user.sessions[user.focusedSessionId] : undefined;
  if (focused) return focused;

  const now = new Date().toISOString();
  const sessionId = createLocalSessionId();
  const created: StandaloneSessionState = {
    id: sessionId,
    claudeSessionId: createClaudeSessionId(),
    title: "inbox",
    status: "active",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    initialized: false,
  };
  user.sessions[sessionId] = created;
  user.focusedSessionId = sessionId;
  touchSession(user, sessionId);
  return created;
}

function createSession(user: StandaloneUserRuntimeState, params: { project?: string; title: string }): StandaloneSessionState {
  const now = new Date().toISOString();
  const sessionId = createLocalSessionId();
  const created: StandaloneSessionState = {
    id: sessionId,
    claudeSessionId: createClaudeSessionId(),
    title: params.title,
    project: params.project,
    status: "active",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    initialized: false,
  };
  user.sessions[sessionId] = created;
  user.focusedSessionId = sessionId;
  touchSession(user, sessionId);

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
    `状态: ${session.status === "active" ? "RUNNING" : "ARCHIVED"}`,
    `当前在做: ${truncateForCard(session.lastUserText || session.title, 100)}`,
    `做到哪: 已完成 ${session.turnCount} 轮`,
    `下一步: ${truncateForCard(session.lastAssistantText || "等待你的下一条消息", 100)}`,
    "你可以回复: 任意事项继续处理，或 /sessions /use 切换会话",
  ].join("\n"));
}

function buildSyncAllCard(user: StandaloneUserRuntimeState): string {
  const lines: string[] = ["[SYNC ALL]"];
  if (user.sessionOrder.length === 0) {
    lines.push("暂无会话，先发普通消息或 /new 创建会话。");
    return lines.join("\n");
  }

  const top = user.sessionOrder.slice(0, 5);
  lines.push(`会话数: ${user.sessionOrder.length}（展示最近 ${top.length} 条）`);
  for (let i = 0; i < top.length; i += 1) {
    const sessionId = top[i];
    const session = user.sessions[sessionId];
    if (!session) continue;
    const focused = user.focusedSessionId === session.id ? "*" : " ";
    lines.push(`${focused}${i + 1}. ${session.title} | ${session.id} | ${session.turnCount}轮`);
  }
  lines.push("用 /use <编号> 或 /use <sessionId> 切换焦点。");
  return trimReplyText(lines.join("\n"));
}

function buildSessionsCard(user: StandaloneUserRuntimeState): string {
  const lines: string[] = ["[SESSIONS]"];
  if (user.sessionOrder.length === 0) {
    lines.push("暂无会话。可发送普通消息自动创建，或 /new <标题>。\n");
    return lines.join("\n");
  }

  const ids = user.sessionOrder.slice(0, MAX_SESSION_LIST);
  for (let i = 0; i < ids.length; i += 1) {
    const session = user.sessions[ids[i]];
    if (!session) continue;
    lines.push(formatSessionLine(i + 1, session, user.focusedSessionId === session.id));
  }
  lines.push("* 表示当前焦点会话");
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
          if (command?.type === "sessions") {
            replyText = buildSessionsCard(userRuntime);
          } else if (command?.type === "new") {
            const created = createSession(userRuntime, {
              project: command.project,
              title: command.title,
            });
            replyText = trimReplyText([
              "已创建并切换到新会话。",
              `会话: ${created.id}`,
              `标题: ${created.title}`,
              `项目: ${created.project || "(未设置)"}`,
            ].join("\n"));
          } else if (command?.type === "use") {
            const target = resolveSessionByTarget(userRuntime, command.target);
            if (!target) {
              replyText = `未找到会话: ${command.target}`;
            } else {
              userRuntime.focusedSessionId = target.id;
              touchSession(userRuntime, target.id);
              replyText = trimReplyText([
                "已切换焦点会话。",
                `会话: ${target.id}`,
                `标题: ${target.title}`,
              ].join("\n"));
            }
          } else if (command?.type === "sync" && command.all) {
            replyText = buildSyncAllCard(userRuntime);
          } else {
            const session = ensureFocusedSession(userRuntime);
            touchSession(userRuntime, session.id);

            if (command?.type === "sync") {
              try {
                const syncText = await runStandaloneClaudeSession(claudeCfg, {
                  mode: "sync",
                  sessionId: session.claudeSessionId,
                  prompt: buildSyncPrompt(session),
                });
                replyText = trimReplyText(syncText || buildSyncCardForSession(session));
              } catch {
                replyText = buildSyncCardForSession(session);
              }
            } else {
              try {
                replyText = await runStandaloneClaudeSession(claudeCfg, {
                  mode: "chat",
                  sessionId: session.claudeSessionId,
                  prompt: body,
                  startNewSession: !session.initialized,
                });
              } catch (err) {
                replyText = `Claude 调用失败: ${String(err)}`;
              }
              updateSessionFromTurn(session, body, replyText);
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
