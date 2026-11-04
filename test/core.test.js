// 鍵（API）なしで確かめられる所の試験。 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNote, parseNote } from "../src/note.js";
import { readLabelText } from "../src/read-label.js";
import { judgeChinaOrigin, judgeUsLacf } from "../src/rules.js";
import { runCheck } from "../src/check.js";

const { note } = loadNote();

test("決まりノートを全部の行読める", () => {
  assert.ok(note.rows.length >= 80, `行数 ${note.rows.length}`);
  for (const c of ["US", "EU", "CN"]) {
    for (const b of ["施設", "交差", "製品"]) {
      assert.ok(note.rows.some((r) => r.country === c && r.box === b), `${c}/${b} が無い`);
    }
  }
  const ids = note.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "行番号が重複している");
  assert.equal(note.rows.find((r) => r.id === "0-1").country, "CN");
});

test("表の形が同じなら、行を足すとそのまま読める", () => {
  const md = `## 1. 米国\n### 1-P 製品の箱\n| # | a | b | c | d | e | f |\n|---|---|---|---|---|---|---|\n| US-P99 | 新しい決まり | 条件 | なし | ラベルで分かる | 出典 【原文】 施行 2027-04-01 | 直せば出せる |\n`;
  const n = parseNote(md);
  assert.equal(n.rows.length, 1);
  assert.equal(n.rows[0].level, "直せば出せる");
  assert.deepEqual(n.rows[0].dates, [{ label: "施行", date: "2027-04-01" }]);
  assert.equal(n.rows[0].weak, false);
});

test("中国の入口：10都県の工場は止まる", () => {
  const label = readLabelText("名称：佃煮\n製造者：株式会社テスト（架空）　長野県テスト村1");
  assert.equal(judgeChinaOrigin(label, {}).status, "無い");
  const label2 = readLabelText("名称：佃煮\n製造者：株式会社テスト（架空）　架空県テスト村1");
  assert.equal(judgeChinaOrigin(label2, {}), null); // 分からない → 質問
  assert.equal(judgeChinaOrigin(label2, { 主な原料の産地: "北海道" }).status, "ある");
  assert.equal(judgeChinaOrigin(label2, { 主な原料の産地: "福島県" }).status, "無い");
});

test("米国の低酸性食品：pH と水分活性の組み合わせで決まる", () => {
  const label = readLabelText("保存方法：常温で保存\n殺菌方法：気密性容器に密封し、加圧加熱殺菌");
  assert.equal(judgeUsLacf(label, {}), null);
  assert.equal(judgeUsLacf(label, { pH: "5.8", Aw: "0.97" }).status, "無い");
  assert.equal(judgeUsLacf(label, { pH: "5.8", Aw: "0.80" }).status, "対象外");
  assert.equal(judgeUsLacf(label, { pH: "4.2", Aw: "0.97" }).status, "対象外");
  assert.equal(judgeUsLacf(label, { pH: "4.6", Aw: "0.97" }).status, "対象外"); // 4.6 ちょうどは対象外
  assert.equal(judgeUsLacf(label, { pH: "5.8", Aw: "0.97", LACFの届け出: "済" }).status, "ある");
  const cold = readLabelText("保存方法：要冷蔵（10℃以下）");
  assert.equal(judgeUsLacf(cold, { pH: "5.8", Aw: "0.97" }).status, "対象外");
});

test("総当たり：答えが返らなかった行も、根拠の合わない行も「分からない」になる", async () => {
  const label = readLabelText("名称：炊き込みごはんの素\n原材料名：とうもろこし、かつお節、ごま油／調味料（アミノ酸等）");
  const fakeJudge = async ({ rows }) => ({
    usage: {},
    results: rows
      .filter((r) => r.id === "US-P1" || r.id === "US-P4")
      .map((r) =>
        r.id === "US-P1"
          ? { row_id: r.id, status: "無い", reason: "ごまの表示が無い", label_quote: "ごま油", absent_on_label: false, answer_keys: [], note_quote: "主要アレルゲン9品目の表示", question: "", todo_kind: "今の表示・原料を直す", todo: "英語表示に sesame を足す" }
          : { row_id: r.id, status: "ある", reason: "うそ", label_quote: "グルタミン酸ナトリウム", absent_on_label: false, answer_keys: [], note_quote: "存在しない文", question: "", todo_kind: "なし", todo: "" },
      ),
  });
  const r = await runCheck({ label, countries: ["US"], judge: fakeJudge, asOf: "2026-11-04" });
  const us = r.countries.US;
  assert.equal(us.items.length, note.rows.filter((x) => x.country === "US").length, "全部の行がある");
  const p1 = us.items.find((i) => i.rowId === "US-P1");
  assert.equal(p1.status, "無い");
  assert.equal(p1.level, "直せば出せる");
  const p4 = us.items.find((i) => i.rowId === "US-P4");
  assert.equal(p4.status, "分からない");
  assert.ok(p4.downgraded);
  const p7 = us.items.find((i) => i.rowId === "US-P7");
  assert.equal(p7.status, "分からない");
  assert.ok(p7.flags[0].startsWith("AIが答えなかった"));
  const p10 = us.items.find((i) => i.rowId === "US-P10");
  assert.ok(p10.upcoming.some((d) => d.date === "2027-01-15"), "赤色3号の施行日がこれから");
});

test("中国の入口：10都県とそれ以外が混ざれば「分からない」、住所が別の行でも拾う", () => {
  const mixed = readLabelText("製造所\n工場A　静岡県御殿場市1\n工場B　群馬県伊勢崎市2");
  const r = judgeChinaOrigin(mixed, {});
  assert.equal(r.status, "分からない");
  assert.ok(r.question.includes("群馬"));
  const sep = readLabelText("【製造元】\n株式会社テスト（架空）\n群馬県テスト市1");
  assert.equal(judgeChinaOrigin(sep, {}).status, "無い");
  const kyoto = readLabelText("製造者：テスト（架空）　京都府京都市1");
  assert.equal(judgeChinaOrigin(kyoto, {}), null); // 京都府は東京都ではない
});

test("EU-P2：文字だけのラベルでは強調を「分からない」にする", async () => {
  const { judgeEuEmphasis } = await import("../src/rules.js");
  assert.equal(judgeEuEmphasis({ fullText: "小麦" }, {}, { status: "ある" }).status, "分からない");
  assert.equal(judgeEuEmphasis({ fullText: "小麦" }, {}, { status: "対象外" }), null);
  assert.equal(judgeEuEmphasis({ fromImage: true }, {}, { status: "ある" }), null);
  assert.equal(judgeEuEmphasis({}, { "アレルゲンの強調": "太字や色で目立たせている" }, {}).status, "ある");
  assert.equal(judgeEuEmphasis({}, { "アレルゲンの強調": "目立たせていない" }, {}).status, "無い");
});
