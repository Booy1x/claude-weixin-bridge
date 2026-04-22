import { startWeixinLoginWithQr, waitForWeixinLogin } from "../auth/login-qr.js";
import { getConfig, getUpdates, sendMessage, sendTyping } from "../api/api.js";
import { MessageItemType, MessageState, MessageType, TypingStatus, type MessageItem } from "../api/types.js";
import { generateId } from "../util/random.js";

import { runStandaloneClaude } from "./claude.js";
import {
  loadStandaloneAccountState,
  loadStandaloneRuntimeState,
  saveStandaloneAccountState,
  saveStandaloneRuntimeState,
} from "./state.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

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

          let replyText = "";
          try {
            replyText = await runStandaloneClaude(
              { from, body },
              claudeCfg,
            );
          } catch (err) {
            replyText = `Claude 调用失败: ${String(err)}`;
          }

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
