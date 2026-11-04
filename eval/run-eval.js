// 答え合わせ。正解つきの試験ケースを全部チェックにかけ、点数を出す。
//
//   npm run eval                      … eval/cases/ の公開ケース（架空の商品）
//   npm run eval -- <フォルダ>         … 別の場所のケースも足す（手元だけの試験データなど）
//   npm run eval -- --only corn-01    … 1件だけ
//
// いちばん大事な数字は「見落とし」＝正解は「無い」（引っかかる）なのに、
// 道具が「ある」「対象外」と言ってしまった行の数。これを 0 にする。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLabelText, readLabelImage } from "../src/read-label.js";
import { runCheck } from "../src/check.js";
import { loadNote } from "../src/note.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const extraDirs = args.filter((a, i) => !a.startsWith("--") && !(onlyIdx >= 0 && i === onlyIdx + 1));
const dirs = [path.join(here, "cases"), ...extraDirs.map((d) => path.resolve(d))];
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 2);

function loadCases() {
  const cases = [];
  for (const dir of [...new Set(dirs)]) {
    if (!fs.existsSync(dir)) {
      console.warn(`フォルダがありません：${dir}`);
      continue;
    }
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      c._dir = dir;
      c._file = f;
      if (!c.expected) continue;
      if (only && c.id !== only) continue;
      cases.push(c);
    }
  }
  return cases;
}

const mediaTypeOf = (f) => ({ ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" })[path.extname(f).toLowerCase()] || "image/jpeg";

async function labelOf(c) {
  if (c.label_text_ja && c.label_text_ja.trim()) return readLabelText(c.label_text_ja);
  const img = (c.images || [])[0];
  if (!img) throw new Error("label_text_ja も images もありません");
  const p = path.join(c._dir, "images", img);
  const base64 = fs.readFileSync(fs.existsSync(p) ? p : path.join(c._dir, img)).toString("base64");
  return readLabelImage({ base64, mediaType: mediaTypeOf(img) });
}

function classify(expected, got) {
  if (expected === got) return "一致";
  const ok = (s) => s === "ある" || s === "対象外";
  if (expected === "無い" && ok(got)) return "見落とし";
  if (ok(expected) && got === "無い") return "空振り";
  if (expected === "無い" && got === "分からない") return "確認に回した";
  return "ずれ";
}

async function runCase(c) {
  const t0 = Date.now();
  const label = await labelOf(c);
  const countries = Object.keys(c.expected);
  const result = await runCheck({ label, countries, answers: c.answers || {}, asOf: c.as_of || c.checked });
  const rows = [];
  let unanswered = 0;
  for (const country of countries) {
    const items = result.countries[country].items;
    unanswered += items.filter((i) => i.flags.some((f) => f.startsWith("AIが答えなかった"))).length;
    for (const [rowId, expected] of Object.entries(c.expected[country])) {
      const item = items.find((i) => i.rowId === rowId);
      const got = item ? item.status : "（ノートに無い行）";
      rows.push({
        country, rowId, expected, got,
        claudeStatus: item?.claudeStatus,
        kind: item ? classify(expected, got) : "ノートに無い行",
        why: c.expected_why?.[rowId] || "",
        reason: item?.reason || "",
        flags: item?.flags || [],
      });
    }
  }
  return { id: c.id, name: c.name || "", seconds: Math.round((Date.now() - t0) / 1000), unanswered, rows, usage: result.usage };
}

async function main() {
  const cases = loadCases();
  if (!cases.length) {
    console.log("試験ケースが見つかりません。");
    return;
  }
  const { note } = loadNote();
  console.log(`試験ケース ${cases.length}件 ／ 決まりノート ${note.rows.length}行（確認日 ${note.confirmedOn}）`);

  const results = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const r = await runCase(c);
          results.push(r);
          const miss = r.rows.filter((x) => x.kind === "見落とし").length;
          console.log(`  ${c.id}  一致 ${r.rows.filter((x) => x.kind === "一致").length}/${r.rows.length}  見落とし ${miss}  (${r.seconds}秒)`);
        } catch (e) {
          results.push({ id: c.id, error: String(e.message || e), rows: [] });
          console.log(`  ${c.id}  失敗：${e.message}`);
        }
      }
    }),
  );
  results.sort((a, b) => a.id.localeCompare(b.id));

  const all = results.flatMap((r) => r.rows);
  const count = (k) => all.filter((x) => x.kind === k).length;
  const total = all.filter((x) => x.kind !== "ノートに無い行").length;
  const mustCatch = all.filter((x) => x.expected === "無い").length;
  const summary = {
    when: new Date().toISOString(),
    noteConfirmedOn: note.confirmedOn,
    noteRows: note.rows.length,
    cases: results.length,
    failedCases: results.filter((r) => r.error).length,
    judgedRows: total,
    一致: count("一致"),
    一致率: total ? Math.round((count("一致") / total) * 1000) / 10 : 0,
    見落とし: count("見落とし"),
    空振り: count("空振り"),
    確認に回した: count("確認に回した"),
    ずれ: count("ずれ"),
    ノートに無い行: count("ノートに無い行"),
    引っかかる行: mustCatch,
    引っかかる行を拾えた: all.filter((x) => x.expected === "無い" && x.got === "無い").length,
    AIが答えなかった行: results.reduce((s, r) => s + (r.unanswered || 0), 0),
    tokens: results.reduce((s, r) => ({ input: s.input + (r.usage?.input || 0), output: s.output + (r.usage?.output || 0) }), { input: 0, output: 0 }),
  };

  const stamp = summary.when.replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(here, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const isPublic = dirs.length === 1;
  const base = path.join(outDir, `${stamp}${isPublic ? "" : "_手元"}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ summary, results }, null, 2));
  fs.writeFileSync(`${base}.md`, toMarkdown(summary, results));

  console.log("\n— 点数 —");
  console.log(`一致 ${summary.一致}/${summary.judgedRows}（${summary.一致率}%）`);
  console.log(`見落とし ${summary.見落とし}（引っかかる ${summary.引っかかる行}行のうち、拾えた ${summary.引っかかる行を拾えた}・確認に回した ${summary.確認に回した}）`);
  console.log(`空振り ${summary.空振り} ／ その他のずれ ${summary.ずれ} ／ AIが答えなかった行 ${summary.AIが答えなかった行}`);
  console.log(`結果：${base}.md`);
}

function toMarkdown(s, results) {
  let md = `# 答え合わせの結果（${s.when}）\n\n`;
  md += `決まりノート ${s.noteRows}行（確認日 ${s.noteConfirmedOn}）／試験ケース ${s.cases}件\n\n`;
  md += `| 項目 | 数 |\n|---|---|\n`;
  for (const k of ["judgedRows", "一致", "一致率", "見落とし", "空振り", "確認に回した", "ずれ", "AIが答えなかった行"]) md += `| ${k === "judgedRows" ? "採点した行" : k} | ${s[k]} |\n`;
  md += `\n「見落とし」＝正解は「無い」（引っかかる）なのに「ある」「対象外」と言った行。いちばん減らしたい数字。\n`;
  for (const r of results) {
    md += `\n## ${r.id} ${r.name || ""}\n\n`;
    if (r.error) { md += `失敗：${r.error}\n`; continue; }
    const bad = r.rows.filter((x) => x.kind !== "一致");
    md += `一致 ${r.rows.length - bad.length}/${r.rows.length}\n\n`;
    if (bad.length) {
      md += `| 国 | 行 | 正解 | 道具 | 種類 | 正解の理由 | 道具の理由 |\n|---|---|---|---|---|---|---|\n`;
      for (const x of bad) md += `| ${x.country} | ${x.rowId} | ${x.expected} | ${x.got} | ${x.kind} | ${x.why.replace(/\|/g, "／")} | ${(x.reason + (x.flags.length ? "（" + x.flags.join("／") + "）" : "")).replace(/\|/g, "／")} |\n`;
    }
  }
  return md;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
