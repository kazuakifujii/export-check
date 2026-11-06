// 小さなサーバー。画面（public/）を配り、Claude API を呼ぶ。
// API の鍵はこのサーバーの中だけで使う（画面＝ブラウザには渡さない）。

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNote } from "./note.js";
import { readLabelImage, readLabelText } from "./read-label.js";
import { runCheck } from "./check.js";
import { MODEL } from "./claude.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "..", "public")));

// 決まりノートをそのまま見せる（画面の「決まりノート」タブ）
app.get("/api/note", (req, res) => {
  const { note, markdown, path: notePath } = loadNote();
  res.json({ confirmedOn: note.confirmedOn, rows: note.rows, markdown, file: path.basename(notePath) });
});

app.get("/api/status", (req, res) => {
  res.json({ model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY });
});

// ラベルを読む
app.post("/api/read", async (req, res) => {
  try {
    const { image, mediaType, text } = req.body;
    const label = image ? await readLabelImage({ base64: image, mediaType }) : readLabelText(text || "");
    res.json(label);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 総当たりのチェック
app.post("/api/check", async (req, res) => {
  try {
    const { label, countries, answers, asOf } = req.body;
    if (!label?.lines?.length) return res.status(400).json({ error: "ラベルの文字がありません" });
    const result = await runCheck({ label, countries: countries?.length ? countries : ["US", "EU", "CN"], answers, asOf });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`輸出チェック： http://localhost:${port} をブラウザで開いてください（モデル ${MODEL}）`);
  if (process.env.CLAUDE_BACKEND === "claude-code") console.log("判定は Claude Code（claude コマンド）で行います。");
  else if (!process.env.ANTHROPIC_API_KEY) console.log("注意：ANTHROPIC_API_KEY が設定されていません（.env に書いてください）");
});
