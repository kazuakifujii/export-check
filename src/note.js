// 決まりノート（Markdown の表）を読み込んで、行の一覧にする。
// ノートの表の形（# 列 + 6列、## 国、### 箱）が変わらなければ、
// ノートを直すだけでプログラムの判定にそのまま反映される。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_NOTE_PATH = path.join(here, "..", "rules", "決まりノート.md");

export const COUNTRIES = { US: "米国", EU: "EU", CN: "中国" };
export const BOXES = ["入口", "施設", "交差", "製品"];
export const LEVELS = ["出せない", "直せば出せる", "確認が必要", "対象外"];

// "## 1. 米国" のような見出しから国を決める
function countryFromHeading(text) {
  if (/入口|最初に見る/.test(text)) return "ALL";
  if (/米国|アメリカ/.test(text)) return "US";
  if (/EU|欧州/.test(text)) return "EU";
  if (/中国/.test(text)) return "CN";
  return null;
}

// "### 1-A 施設の箱" のような見出しから箱を決める
// 行番号の文字（F＝施設、X＝交差、P＝製品）を見出しより優先する。
// 調査で行が別の見出しの下に足されても、箱を取り違えないため。
function boxFromId(id) {
  const m = id.match(/^(?:US|EU|CN)-([FXP])\d+$/);
  return m ? { F: "施設", X: "交差", P: "製品" }[m[1]] : null;
}

function boxFromHeading(text) {
  if (/施設/.test(text)) return "施設";
  if (/交差/.test(text)) return "交差";
  if (/製品/.test(text)) return "製品";
  return null;
}

// 入口の行（0-1 など）は、要件の書き出し「中国：」「米国：」で国を決める
function countryFromRowText(text) {
  if (/^(中国)/.test(text)) return "CN";
  if (/^(米国|アメリカ)/.test(text)) return "US";
  if (/^(EU|欧州)/.test(text)) return "EU";
  return "ALL";
}

const clean = (s) => s.replace(/\*\*/g, "").replace(/<br\s*\/?>/g, " ").trim();

// "施行 2027-01-15" "延期 2028-07-20" のような日付を拾う
const DATE_LABELS = "施行|改訂|期限|公告|解除|免除|猶予|例外|小規模|適用|延期|から|まで";
export function findDates(text) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(`(${DATE_LABELS})?\\s*[:：]?\\s*(\\d{4}-\\d{2}-\\d{2})(から|まで)?`, "g");
  for (const m of text.matchAll(re)) {
    let label = m[1] || m[3];
    if (!label) continue; // 見出しの無い日付（ページの日付など）は使わない
    if (label === "から") label = "施行";
    if (label === "まで") label = "期限";
    const key = label + m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, date: m[2] });
  }
  return out;
}

// (6) の列の書き出しから「足りないときの3段階」を読む
export function levelFromText(text) {
  let best = null;
  let bestIdx = Infinity;
  for (const lv of LEVELS) {
    const i = text.indexOf(lv);
    if (i >= 0 && i < bestIdx) {
      best = lv;
      bestIdx = i;
    }
  }
  return best || "確認が必要";
}

export function parseNote(markdown) {
  const rows = [];
  let country = null;
  let box = null;
  let confirmedOn = null;

  const dm = markdown.match(/確認日[:：]\s*(\d{4}-\d{2}-\d{2})/);
  if (dm) confirmedOn = dm[1];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      // 国の章でなければ（「4. 大事な変化」など）表を読まない
      country = countryFromHeading(line);
      box = country === "ALL" ? "入口" : null;
      continue;
    }
    if (line.startsWith("### ")) {
      box = boxFromHeading(line) || box;
      continue;
    }
    if (!country || !line.startsWith("|")) continue;

    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const id = clean(cells[0] || "");
    if (!/^(0|US|EU|CN)-[A-Z]?\d+$/.test(id)) continue; // 見出し行・区切り行は飛ばす
    if (cells.length < 7) continue;

    const [title, condition, exception, labelOrQuestion, source, ifMissing, ...extra] = cells
      .slice(1)
      .map(clean);
    const rowCountry = country === "ALL" ? countryFromRowText(title) : country;
    const marks = [...source.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
    const weak = marks.length === 0 || marks.some((m) => /要照合|二次/.test(m));

    rows.push({
      id,
      country: rowCountry,
      box: boxFromId(id) || box || "製品",
      title,
      condition,
      exception,
      labelOrQuestion,
      source,
      ifMissing,
      extra,
      level: levelFromText(ifMissing),
      marks,
      weak,
      dates: findDates([condition, exception, source].join(" ")),
      urls: [...source.matchAll(/https?:\/\/[^\s）)、]+/g)].map((m) => m[0]),
    });
  }
  return { confirmedOn, rows };
}

// ファイルが変わったら読み直す（ノートが直ればすぐ反映される）
let cache = { path: null, mtimeMs: 0, note: null, markdown: "" };
export function loadNote(notePath = process.env.NOTE_PATH || DEFAULT_NOTE_PATH) {
  const stat = fs.statSync(notePath);
  if (cache.path === notePath && cache.mtimeMs === stat.mtimeMs) return cache;
  const markdown = fs.readFileSync(notePath, "utf8");
  const note = parseNote(markdown);
  cache = { path: notePath, mtimeMs: stat.mtimeMs, note, markdown };
  return cache;
}

// ある国で総当たりする行（入口の行のうちその国のもの＋その国の行）
export function rowsForCountry(note, country) {
  return note.rows.filter((r) => r.country === country || r.country === "ALL");
}

// 1行を、Claude に渡す文章にする
export function rowToText(r) {
  return [
    `行番号: ${r.id}`,
    `箱: ${r.box}`,
    `(1) 要件: ${r.title}`,
    `(2) 条件: ${r.condition}`,
    `(3) 例外: ${r.exception}`,
    `(4) ラベルで判定できるか／聞き返す質問: ${r.labelOrQuestion}`,
    `(5) 出どころ: ${r.source}`,
    `(6) 足りないとき: ${r.ifMissing}`,
  ].join("\n");
}
