// ラベルの写真（または文字）から、書いてあることを一字一句読み取る。
// ここでは判定をしない。読むだけ。

import { askJson } from "./claude.js";

const FIELDS = [
  "名称",
  "原材料名",
  "添加物",
  "アレルゲン表示",
  "原料原産地",
  "内容量",
  "賞味期限",
  "保存方法",
  "殺菌方法",
  "製造者",
  "販売者",
  "製造所固有記号",
  "栄養成分表示",
  "外国語の表示",
  "登録番号",
  "その他",
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "fields", "unreadable"],
  properties: {
    lines: {
      type: "array",
      description: "ラベルに書いてある文字を、上から順に1行ずつ、一字一句そのまま",
      items: { type: "string" },
    },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value"],
        properties: {
          name: { type: "string", enum: FIELDS },
          value: { type: "string", description: "ラベルの文字そのまま。言い換えない" },
        },
      },
    },
    unreadable: {
      type: "array",
      description: "かすれ・隠れ・小さすぎなどで読めなかった所",
      items: { type: "string" },
    },
  },
};

const SYSTEM = `あなたは食品表示ラベルの文字を書き写す係です。
- ラベルに書いてある文字を、一字一句そのまま書き写します。要約・言い換え・補足はしません。
- 書いていないことを推測で足しません。読めない所は unreadable に書きます。
- fields には、見出し（名称、原材料名など）ごとに中身を写します。見出しが無い項目は入れません。
- 「/」や「、」などの区切りもラベルどおりに残します。`;

export async function readLabelImage({ base64, mediaType }) {
  const { data, usage } = await askJson({
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 16000,
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: "このラベルを書き写してください。" },
    ],
  });
  return { ...normalizeLabel(data), usage };
}

// 文字で渡されたラベル（試験データなど）は、そのまま行に分ける
export function readLabelText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fields = [];
  for (const l of lines) {
    const m = l.replace(/^[●・■◆○\-\s]+/, "").match(/^([^：:]{1,12})[：:]\s*(.*)$/);
    if (m) fields.push({ name: m[1].replace(/\s/g, ""), value: m[2].trim() });
  }
  return normalizeLabel({ lines, fields, unreadable: [] });
}

function normalizeLabel(data) {
  return {
    lines: data.lines || [],
    fields: data.fields || [],
    unreadable: data.unreadable || [],
    fullText: (data.lines || []).join("\n"),
  };
}
