// Claude API を呼ぶところ。鍵（ANTHROPIC_API_KEY）はサーバーの中だけで使い、画面には出さない。

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = process.env.CLAUDE_EFFORT || "high";

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("API の鍵（ANTHROPIC_API_KEY）が設定されていません。.env ファイルに書いて、サーバーを起動し直してください。");
  }
  if (!client) client = new Anthropic();
  return client;
}

// JSON の形（schema）を指定して、その形の答えだけを返してもらう
export async function askJson({ system, content, schema, maxTokens = 32000 }) {
  if (process.env.CLAUDE_BACKEND === "claude-code") return askJsonViaClaudeCode({ system, content, schema });
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  };

  const stream = getClient().messages.stream(params);
  const msg = await stream.finalMessage();

  if (msg.stop_reason === "refusal") {
    throw new Error("Claude がこの依頼を断りました（refusal）。入力を見直してください。");
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("答えが長すぎて途中で切れました（max_tokens）。");
  }
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { data: JSON.parse(text), usage: msg.usage };
}

// 手元の試験用：API の代わりに、PC にログイン済みの Claude Code（claude -p）で判定する。
// 写真も読めるように、メッセージを stream-json の形で渡す（藤井さん 11/7）。公開する道具の本体は API を使う。
let loggedOnce = false;
function askJsonViaClaudeCode({ system, content, schema }) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: content }];
  const message = JSON.stringify({ type: "user", message: { role: "user", content: parts } });
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", MODEL, "--effort", EFFORT, "--tools", "", "--system-prompt", system, "--json-schema", JSON.stringify(schema)];
  // API の鍵を渡すと Claude Code が鍵の残高で動くので、鍵を外してプラン（ログイン）で動かす
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        // 1行に1つの JSON が流れてくる。最後の「result」の行に答えが入っている
        const line = out.split("\n").filter((l) => l.includes('"type":"result"')).pop();
        if (!line) throw new Error("Claude Code の答えが読めません");
        const r = JSON.parse(line);
        if (r.is_error || !r.structured_output) throw new Error(r.result || "Claude Code の答えが読めません");
        if (!loggedOnce) {
          loggedOnce = true;
          console.log(`（Claude Code で判定中。API の鍵は渡していません。Claude Code が示した定価換算 $${(r.total_cost_usd || 0).toFixed(2)}／1回）`);
        }
        const u = r.usage || {};
        resolve({
          data: r.structured_output,
          usage: {
            input_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            output_tokens: u.output_tokens || 0,
          },
        });
      } catch (e) {
        reject(new Error(`Claude Code での判定に失敗しました（終了コード ${code}）：${e.message} ${err.slice(0, 300)}`));
      }
    });
    child.stdin.end(message + "\n");
  });
}
