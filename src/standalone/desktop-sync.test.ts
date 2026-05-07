import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRecentDesktopProjectSyncText } from "./desktop-sync.js";

function mkClaudeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cw-claude-"));
}

describe("buildRecentDesktopProjectSyncText", () => {
  it("uses the latest non-bridge desktop project and ignores command-only entries", () => {
    const claudeDir = mkClaudeDir();
    fs.mkdirSync(path.join(claudeDir, "projects", "-home-booy1x-project-prj2"), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "history.jsonl"), [
      JSON.stringify({ display: "回复了我'你好！我在，随时可以开始'", project: "/home/booy1x/project/prj1/claude-weixin-bridge", sessionId: "bridge-1" }),
      JSON.stringify({ display: "/new", project: "/home/booy1x/project/prj2", sessionId: "desktop-1" }),
      JSON.stringify({ display: "现在这个项目使用了Expo go，我想在expo go中登录我的账号", project: "/home/booy1x/project/prj2", sessionId: "desktop-1" }),
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(claudeDir, "projects", "-home-booy1x-project-prj2", "desktop-1.jsonl"), [
      JSON.stringify({ type: "custom-title", customTitle: "ios-sleep-app-mvp", sessionId: "desktop-1" }),
    ].join("\n"), "utf-8");

    const text = buildRecentDesktopProjectSyncText({
      claudeDir,
      excludeProject: "/home/booy1x/project/prj1/claude-weixin-bridge",
    });

    expect(text).toContain("最近项目: ios-sleep-app-mvp");
    expect(text).toContain("当前状态: 现在这个项目使用了Expo go，我想在expo go中登录我的账号");
    expect(text).toContain("下一步: 回到电脑端继续 ios-sleep-app-mvp");
  });

  it("returns a fallback summary when no desktop project is found", () => {
    const claudeDir = mkClaudeDir();
    fs.writeFileSync(path.join(claudeDir, "history.jsonl"), "", "utf-8");

    const text = buildRecentDesktopProjectSyncText({ claudeDir, excludeProject: "/tmp/bridge" });

    expect(text).toContain("最近项目: 暂无");
    expect(text).toContain("当前状态: 没找到电脑端项目记录");
  });
});
