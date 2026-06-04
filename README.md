# claude-weixin-bridge

[简体中文](./README.zh_CN.md)

A standalone Weixin bridge for Claude Code, with QR-code login, message polling, media upload, and local runtime state management.

## Overview

`claude-weixin-bridge` is a standalone Weixin bridge for Claude Code. It handles QR-code login, message polling, media upload, and local runtime state for a Weixin-connected workflow.

## Prerequisites

- Node.js `>=22`
- A local Claude CLI available as `claude`, or a custom command set via `CLAUDE_CMD`

Install dependencies:

```bash
npm install
```

## Common Commands

Run QR-code login:

```bash
npm run standalone:login
```

Start the standalone bridge:

```bash
npm run standalone:run
```

Run tests:

```bash
npm run test:run
```

## Runtime Notes

- Login and runtime state are stored under `~/.claude-weixin/` by default
- You can override the state directory with `CLAUDE_WEIXIN_STATE_DIR`
- You can override the Claude executable with `CLAUDE_CMD`
- Multiple Weixin accounts are supported by repeated QR-code logins

### Conversation context

Each Weixin session maps to a native Claude Code session. The first message
creates the session with `--session-id`; every later message resumes it with
`--resume`, so Claude restores the full conversation from its own on-disk store.
This means context survives bridge restarts and is not truncated to a few recent
turns. If a resume fails (e.g. the session was never persisted, or its working
directory is gone), the turn is transparently retried as a fresh session.

Relevant environment variables:

- `CLAUDE_CMD` — agent executable (default `claude`)
- `CLAUDE_WORKDIR` — working directory the agent runs in (default: process cwd).
  Imported desktop sessions override this with their original project path.
- `CLAUDE_EXTRA_ARGS` — extra CLI flags passed verbatim (e.g. `--model sonnet`,
  `--permission-mode acceptEdits`). The legacy `CLAUDE_ARGS` is still honored for
  flags other than the now built-in `-p` / `{{prompt}}`.
- `CLAUDE_SYSTEM_PROMPT`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MAX_OUTPUT_CHARS`,
  `CLAUDE_ENV_ALLOWLIST` — system prompt, per-turn timeout, output cap, and the
  env vars forwarded to the agent process.
- `CLAUDE_PERMISSION_MODE` — passed through as `--permission-mode` when set to a
  valid mode (`default`, `plan`, `acceptEdits`, `bypassPermissions`, …). Unknown
  values are ignored with a warning. Leave unset to use Claude's own default.

### Access control

The bridge runs the agent (and reads/writes files, runs commands) on the host,
so an unauthenticated sender is effectively remote code execution. Access is
controlled by `WEIXIN_ALLOW_FROM` (comma-separated sender ids):

- The **logged-in owner** (the account that scanned the QR code) is always
  allowed, so a fresh install is locked to you by default.
- Add more ids via `WEIXIN_ALLOW_FROM` to allow additional senders.
- Set `WEIXIN_ALLOW_FROM=*` to explicitly allow everyone (logged on startup).
- Only when the owner id is unknown **and** `WEIXIN_ALLOW_FROM` is empty does the
  bridge fall back to allow-all — it logs a loud warning in that case.

Combining allow-all with `--permission-mode bypassPermissions` turns the bot
into an open shell on your machine; the bridge warns when it detects this.

### Concurrency

Messages are dispatched off the polling loop: each sender has its own serial
lane (their messages are handled in order, and a session is never resumed twice
at once), while different senders — and the long-poll itself — run concurrently.
A long task from one user therefore no longer blocks polling or other users, and
the "typing…" indicator is refreshed for the duration of a turn.

## Backend API Protocol

This bridge communicates with the backend gateway via HTTP JSON API. Developers integrating with their own backend need to implement the following interfaces.

All endpoints use `POST` with JSON request and response bodies. Common request headers:

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `AuthorizationType` | Fixed value `ilink_bot_token` |
| `Authorization` | `Bearer <token>` (obtained after login) |
| `X-WECHAT-UIN` | Base64-encoded random uint32 |

### Endpoint List

| Endpoint | Path | Description |
|----------|------|-------------|
| getUpdates | `getupdates` | Long-poll for new messages |
| sendMessage | `sendmessage` | Send a message (text/image/video/file) |
| getUploadUrl | `getuploadurl` | Get CDN upload pre-signed URL |
| getConfig | `getconfig` | Get account config (typing ticket, etc.) |
| sendTyping | `sendtyping` | Send/cancel typing status indicator |

### getUpdates

Long-polling endpoint. The server responds when new messages arrive or on timeout.

**Request body:**

```json
{
  "get_updates_buf": ""
}
```

| Field | Type | Description |
|-------|------|-------------|
| `get_updates_buf` | `string` | Sync cursor from the previous response; empty string for the first request |

**Response body:**

```json
{
  "ret": 0,
  "msgs": [...],
  "get_updates_buf": "<new cursor>",
  "longpolling_timeout_ms": 35000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ret` | `number` | Return code, `0` = success |
| `errcode` | `number?` | Error code (e.g., `-14` = session timeout) |
| `errmsg` | `string?` | Error description |
| `msgs` | `WeixinMessage[]` | Message list (structure below) |
| `get_updates_buf` | `string` | New sync cursor to pass in the next request |
| `longpolling_timeout_ms` | `number?` | Server-suggested long-poll timeout for the next request (ms) |

### sendMessage

Send a message to a user.

**Request body:**

```json
{
  "msg": {
    "to_user_id": "<target user ID>",
    "context_token": "<conversation context token>",
    "item_list": [
      {
        "type": 1,
        "text_item": { "text": "Hello" }
      }
    ]
  }
}
```

### getUploadUrl

Get CDN upload pre-signed parameters. Call this endpoint before uploading a file to obtain `upload_param` and `thumb_upload_param`.

**Request body:**

```json
{
  "filekey": "<file identifier>",
  "media_type": 1,
  "to_user_id": "<target user ID>",
  "rawsize": 12345,
  "rawfilemd5": "<plaintext MD5>",
  "filesize": 12352,
  "thumb_rawsize": 1024,
  "thumb_rawfilemd5": "<thumbnail plaintext MD5>",
  "thumb_filesize": 1040
}
```

| Field | Type | Description |
|-------|------|-------------|
| `media_type` | `number` | `1` = IMAGE, `2` = VIDEO, `3` = FILE |
| `rawsize` | `number` | Original file plaintext size |
| `rawfilemd5` | `string` | Original file plaintext MD5 |
| `filesize` | `number` | Ciphertext size after AES-128-ECB encryption |
| `thumb_rawsize` | `number?` | Thumbnail plaintext size (required for IMAGE/VIDEO) |
| `thumb_rawfilemd5` | `string?` | Thumbnail plaintext MD5 (required for IMAGE/VIDEO) |
| `thumb_filesize` | `number?` | Thumbnail ciphertext size (required for IMAGE/VIDEO) |

**Response body:**

```json
{
  "upload_param": "<original image upload encrypted parameters>",
  "thumb_upload_param": "<thumbnail upload encrypted parameters>"
}
```

### getConfig

Get account configuration, including the typing ticket.

**Request body:**

```json
{
  "ilink_user_id": "<user ID>",
  "context_token": "<optional, conversation context token>"
}
```

**Response body:**

```json
{
  "ret": 0,
  "typing_ticket": "<base64-encoded typing ticket>"
}
```

### sendTyping

Send or cancel the typing status indicator.

**Request body:**

```json
{
  "ilink_user_id": "<user ID>",
  "typing_ticket": "<obtained from getConfig>",
  "status": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `number` | `1` = typing, `2` = cancel typing |

### Message Structure

#### WeixinMessage

| Field | Type | Description |
|-------|------|-------------|
| `seq` | `number?` | Message sequence number |
| `message_id` | `number?` | Unique message ID |
| `from_user_id` | `string?` | Sender ID |
| `to_user_id` | `string?` | Receiver ID |
| `create_time_ms` | `number?` | Creation timestamp (ms) |
| `session_id` | `string?` | Session ID |
| `message_type` | `number?` | `1` = USER, `2` = BOT |
| `message_state` | `number?` | `0` = NEW, `1` = GENERATING, `2` = FINISH |
| `item_list` | `MessageItem[]?` | Message content list |
| `context_token` | `string?` | Conversation context token, must be passed back when replying |

#### MessageItem

| Field | Type | Description |
|-------|------|-------------|
| `type` | `number` | `1` TEXT, `2` IMAGE, `3` VOICE, `4` FILE, `5` VIDEO |
| `text_item` | `{ text: string }?` | Text content |
| `image_item` | `ImageItem?` | Image (with CDN reference and AES key) |
| `voice_item` | `VoiceItem?` | Voice (SILK encoded) |
| `file_item` | `FileItem?` | File attachment |
| `video_item` | `VideoItem?` | Video |
| `ref_msg` | `RefMessage?` | Referenced message |

#### CDN Media Reference (CDNMedia)

All media types (image/voice/file/video) are transferred via CDN using AES-128-ECB encryption:

| Field | Type | Description |
|-------|------|-------------|
| `encrypt_query_param` | `string?` | Encrypted parameters for CDN download/upload |
| `aes_key` | `string?` | Base64-encoded AES-128 key |

### CDN Upload Flow

1. Calculate the file's plaintext size, MD5, and ciphertext size after AES-128-ECB encryption
2. If a thumbnail is needed (image/video), calculate the thumbnail's plaintext and ciphertext parameters as well
3. Call `getUploadUrl` to get `upload_param` (and `thumb_upload_param`)
4. Encrypt the file content with AES-128-ECB and PUT upload to the CDN URL
5. Encrypt and upload the thumbnail in the same way
6. Use the returned `encrypt_query_param` to construct a `CDNMedia` reference, include it in the `MessageItem`, and send

> For complete type definitions, see [`src/api/types.ts`](src/api/types.ts). For API call implementations, see [`src/api/api.ts`](src/api/api.ts).

## Cleanup

Remove local runtime state:

```bash
rm -rf ~/.claude-weixin
```

## Troubleshooting

### `npm run standalone:login` fails

Check that your local Claude CLI is available:

```bash
claude --version
```

If you use a custom Claude executable, set `CLAUDE_CMD` before running the login flow.

### `npm run standalone:run` exits immediately

Check that the login state exists under `~/.claude-weixin/` and try logging in again:

```bash
npm run standalone:login
```

### Need a clean local reset

Remove the local state directory and log in again:

```bash
rm -rf ~/.claude-weixin
npm run standalone:login
```
