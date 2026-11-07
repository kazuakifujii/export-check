// 要件調査で更新された輸出ルール表を、このリポジトリの rules/ に取り込む。
//   npm run sync-note -- <輸出ルール表のファイル>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNote } from "../src/note.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error("使い方：npm run sync-note -- <輸出ルール表のファイル>");
  process.exit(1);
}
const md = fs.readFileSync(src, "utf8");
const { rows, confirmedOn } = parseNote(md);
if (rows.length < 10) {
  console.error(`表が読めません（${rows.length}行）。表の形が変わっていないか見てください。`);
  process.exit(1);
}
const dst = path.join(here, "..", "rules", "輸出ルール表.md");
const before = fs.existsSync(dst) ? parseNote(fs.readFileSync(dst, "utf8")).rows.map((r) => r.id) : [];
fs.writeFileSync(dst, md);
const after = rows.map((r) => r.id);
console.log(`取り込みました：${rows.length}行（確認日 ${confirmedOn}）`);
const added = after.filter((id) => !before.includes(id));
const removed = before.filter((id) => !after.includes(id));
if (added.length) console.log(`増えた行：${added.join(", ")}`);
if (removed.length) console.log(`消えた行：${removed.join(", ")}`);
