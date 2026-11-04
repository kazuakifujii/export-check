// Claude API を呼ぶところ。鍵（ANTHROPIC_API_KEY）はサーバーの中だけで使い、画面には出さない。

import Anthropic from "@anthropic-ai/sdk";

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
