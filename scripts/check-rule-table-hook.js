// Claude Code のフック（.claude/settings.json の PostToolUse）から呼ばれる。
// 輸出ルール表を書き換えたときだけ、表の形が崩れていないか試験を流す。
// 崩れていたら終了コード2で知らせ、Claude に直させる。
import { execFileSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let filePath = "";
try {
  filePath = JSON.parse(input)?.tool_input?.file_path ?? "";
} catch {
  process.exit(0);
}
if (!filePath.endsWith("輸出ルール表.md")) process.exit(0);

try {
  execFileSync(process.execPath, ["--test", "test/core.test.js"], { stdio: "pipe", cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() });
} catch (e) {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 20).join("\n");
  console.error(`輸出ルール表を直したあとの試験が通りません。表の形（# 列＋6列、## 国、### 箱）を確かめてください。\n${out}`);
  process.exit(2);
}
