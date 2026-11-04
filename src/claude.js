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
// 画像は渡せないので、文字のラベルだけ。公開する道具の本体は API を使う。
function askJsonViaClaudeCode({ system, content, schema }) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: content }];
  if (parts.some((p) => p.type !== "text")) {
    return Promise.reject(new Error("Claude Code での判定は文字のラベルだけに対応しています"));
  }
  const prompt = parts.map((p) => p.text).join("\n\n");
  const args = ["-p", "--output-format", "json", "--model", MODEL, "--tools", "", "--system-prompt", system, "--json-schema", JSON.stringify(schema)];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const r = JSON.parse(out);
        if (r.is_error || !r.structured_output) throw new Error(r.result || "Claude Code の答えが読めません");
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
    child.stdin.end(prompt);
  });
}
