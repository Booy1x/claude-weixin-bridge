# Changelog

[简体中文](CHANGELOG.zh_CN.md)

This project follows the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added

- **Agent backend abstraction (`AgentBackend`):** Pluggable interface (`createSession`/`runTurn`/`resume` semantics via `newSessionId` + `runTurn`) so the bridge can drive different coding-agent CLIs. Claude Code is the first implementation (`ClaudeBackend`); future backends (e.g. OpenCode) only need to register an adapter.
- **Native Claude session resume:** Each Weixin session now maps to a native Claude session — first turn creates it with `--session-id`, later turns resume with `--resume`. Context survives bridge restarts and is no longer truncated to the last few turns. `CLAUDE_WORKDIR` and `CLAUDE_EXTRA_ARGS` env vars added.
- **Owner-locked access by default:** The logged-in owner (QR scanner) is always allowlisted, so a fresh install is restricted to that user instead of allowing everyone. `WEIXIN_ALLOW_FROM` adds more senders; `WEIXIN_ALLOW_FROM=*` opts back into allow-all (with a startup warning).
- **Permission mode:** `CLAUDE_PERMISSION_MODE` is forwarded as `--permission-mode` (validated against known modes). The bridge warns on the dangerous combination of allow-all + `bypassPermissions`.
- **Concurrent, non-blocking message handling:** Turns are dispatched off the polling loop via a per-sender serial queue — a long task no longer blocks the long-poll or other senders, while same-sender messages stay ordered and a session is never resumed twice at once. The typing indicator is refreshed during long turns.

### Changed

- Session state gains `backend`, `agentSessionStarted`, and `cwd` fields. The in-memory conversation-history map and manual prompt stuffing are removed in favor of native resume.
- A failed resume (`No conversation found`) now transparently falls back to starting a fresh session instead of surfacing the error.
- Unauthorized senders are now rejected (and logged) instead of silently dropped; runtime state is held in memory and saved synchronously rather than reloaded from disk per message.

## [2.1.7] - 2026-04-07

### Fixed

- **Plugin registration re-entrance:** Lazy-import `monitorWeixinProvider` inside `startAccount` in `channel.ts` to avoid pulling in the monitor → process-message → command-auth chain at plugin registration time, which could re-enter the plugin/provider registry before the account starts.
- **Initialization side effect:** Lazy-import `resolveSenderCommandAuthorizationWithRuntime` / `resolveDirectDmAuthorizationOutcome` in `process-message.ts` to prevent `ensureContextWindowCacheLoaded` from being triggered during module initialization, which caused `loadOpenClawPlugins` re-entrance.

### Changed

- **Tool-call outbound path:** `sendWeixinOutbound` now applies `StreamingMarkdownFilter` to the outbound text, consistent with the model-output path in `process-message`.

## [2.1.4] - 2026-04-03

### Changed

- **QR login:** Remove client-side timeout for `get_bot_qrcode`; the request is no longer aborted on a fixed deadline (server / stack limits still apply).

## [2.1.3] - 2026-04-02

### Added

- **`StreamingMarkdownFilter`** (`src/messaging/markdown-filter.ts`): outbound text no longer runs through whole-string `markdownToPlainText` stripping; a streaming character filter replaces it, so Markdown goes from **effectively unsupported** to **partially supported**.

### Changed

- **Outbound text path:** `process-message` uses `StreamingMarkdownFilter` (`feed` / `flush`) per deliver chunk instead of `markdownToPlainText`.

### Removed

- **`markdownToPlainText`** from `src/messaging/send.ts` (and its tests from `send.test.ts`); coverage moves to `markdown-filter.test.ts`.

## [2.1.2] - 2026-04-02

### Changed

- **Config reload after login:** On each successful Weixin login, bump `channels.openclaw-weixin.channelConfigUpdatedAt` (ISO 8601) in `openclaw.json` so the gateway reloads config from disk, instead of writing an empty `accounts: {}` placeholder.
- **QR login:** Increase client timeout for `get_bot_qrcode` from 5s to 10s.
- **Docs:** Uninstall instructions now use `openclaw plugins uninstall @tencent-weixin/openclaw-weixin` (aligned with the plugins CLI).
- **Logging:** `debug-check` log line no longer includes `stateDir` / `OPENCLAW_STATE_DIR`.

### Removed

- **`openclaw-weixin` CLI subcommands** (`src/weixin-cli.ts` and registration in `index.ts`). Use the host `openclaw plugins uninstall …` flow instead.

### Fixed

- Resolves the **dangerous code pattern** warning when installing the plugin on **OpenClaw 2026.3.31+** (host plugin install / static checks).
