// 鍵（API）なしで確かめられる所の試験。 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNote, parseNote, rowsForCountry } from "../src/note.js";
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
  assert.equal(us.items.length, rowsForCountry(note, "US").length, "全部の行がある");
  const p1 = us.items.find((i) => i.rowId === "US-P1");
  assert.equal(p1.status, "無い");
  assert.equal(p1.level, "直せば出せる");
  const p4 = us.items.find((i) => i.rowId === "US-P4");
  assert.equal(p4.status, "分からない");
  assert.ok(p4.downgraded);
  const p5 = us.items.find((i) => i.rowId === "US-P5");
  assert.equal(p5.status, "分からない");
  assert.ok(p5.flags[0].startsWith("AIが答えなかった"));
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

test("EU-P2：アレルゲンの強調は「輸出用に足す」で出す", async () => {
  const { judgeEuEmphasis } = await import("../src/rules.js");
  const r = judgeEuEmphasis({ fullText: "小麦" }, {}, { status: "ある" });
  assert.equal(r.status, "無い");
  assert.equal(r.todo_kind, "輸出用の表示で足す");
  assert.equal(judgeEuEmphasis({ fullText: "りんご" }, {}, { status: "対象外" }), null);
});

test("見立て：入口で無理／現実的に厳しい／回避策がある／進められる見込み", async () => {
  const { verdictOf } = await import("../src/check.js");
  const it = (o) => ({ rowId: "X", title: "t", reason: "", workaround: "", hard: false, box: "製品", level: "問題なし", ...o });
  assert.equal(verdictOf([it({})]).tier, "進められる見込み");
  assert.equal(verdictOf([it({ level: "出せない", box: "入口" })]).tier, "入口で無理");
  assert.equal(verdictOf([it({ level: "出せない" })]).tier, "現実的に厳しい");
  assert.equal(verdictOf([it({ level: "出せない", workaround: "冷蔵にする" })]).tier, "回避策がある");
  assert.equal(verdictOf([it({ level: "直せば出せる", hard: true, workaround: "冷蔵にする" })]).tier, "回避策がある");
  assert.equal(verdictOf([it({ level: "直せば出せる", hard: true })]).tier, "現実的に厳しい");
});

test("見立て：この製品だから必要な要件で回避策のある直す所は「回避策がある」", async () => {
  const { verdictOf } = await import("../src/check.js");
  const it = (o) => ({ rowId: "X", title: "t", reason: "", workaround: "", hard: false, box: "製品", level: "問題なし", ...o });
  assert.equal(verdictOf([it({ level: "直せば出せる", box: "交差", workaround: "冷蔵で流通" })]).tier, "回避策がある");
  assert.equal(verdictOf([it({ level: "直せば出せる", box: "製品", workaround: "表示を直す" })]).tier, "進められる見込み");
});

import { usCannedClass } from "../src/rules.js";
import { readLabelText as rl2 } from "../src/read-label.js";
test("米国の缶詰・レトルトの区分", () => {
  const L = rl2("名称：炊き込みごはんの素\n原材料名：とうもろこし、しょうゆ\n保存方法：常温で保存\n殺菌方法：気密性容器に密封し、加圧加熱殺菌");
  assert.equal(usCannedClass(L, {}).cls, "低酸性缶詰食品");
  assert.equal(usCannedClass(L, {}).sure, false);
  assert.equal(usCannedClass(L, { pH: "5.8", Aw: "0.97" }).sure, true);
  assert.equal(usCannedClass(L, { pH: "4.2", Aw: "0.97" }).cls, "対象外");
  assert.equal(usCannedClass(L, { 保存: "ずっと冷蔵" }).cls, "冷蔵・冷凍");
  assert.equal(usCannedClass(L, { pH: "5.8", Aw: "0.80" }).cls, "対象外");
  const A = rl2("名称：甘酢漬け\n原材料名：しょうが、醸造酢、砂糖\n保存方法：常温\n殺菌方法：密封後加熱殺菌");
  assert.equal(usCannedClass(A, {}).cls, "酸性化食品");
});
test("米国の区分：誤って低酸性・酸性化にしない", () => {
  const c = (t) => usCannedClass(rl2(t), {}).cls;
  assert.notEqual(c("名称：せんべい\n原材料名：うるち米、しょうゆ\n保存方法：常温"), "低酸性缶詰食品");
  assert.notEqual(c("名称：米みそ\n原材料名：大豆、米、食塩\n保存方法：常温\n殺菌方法：非加熱"), "低酸性缶詰食品");
  assert.equal(c("名称：いちごジャム\n原材料名：いちご、砂糖、クエン酸\n保存方法：常温\n殺菌方法：密封後加熱殺菌"), "対象外");
  assert.equal(c("名称：栗ご飯の素\n原材料名：栗、乳酸Ca\n保存方法：常温\n殺菌方法：気密性容器に密封し、加圧加熱殺菌"), "低酸性缶詰食品");
  assert.equal(c("名称：どら焼\n原材料名：小麦粉、砂糖\n保存方法：常温"), "分からない");
});
test("米国：冷蔵にしても肉・ジュースの決まりは消えない、語の誤り", () => {
  const sp = (t) => usCannedClass(rl2(t), {}).special.map((x) => x.key);
  assert.deepEqual(sp("名称：ビーフカレー\n原材料名：牛肉、たまねぎ\n保存方法：要冷蔵"), ["肉"]);
  assert.deepEqual(sp("名称：りんごジュース\n原材料名：りんご\n保存方法：要冷蔵"), ["ジュース"]);
  assert.deepEqual(sp("名称：ビーフン\n原材料名：うるち米\n保存方法：常温"), []);
  assert.deepEqual(sp("名称：サイダー\n原材料名：ぶどう糖果糖液糖\n保存方法：常温"), []);
  assert.deepEqual(sp("名称：ツナ缶\n原材料名：まぐろ、植物油\n保存方法：常温\n殺菌方法：缶詰"), ["水産"]);
});
test("米国：水産の語の誤り、肉入りは肉の量が先", () => {
  const sp = (t) => usCannedClass(rl2(t), {}).special.map((x) => x.key);
  assert.deepEqual(sp("名称：さけるチーズ\n原材料名：生乳、食塩\n保存方法：要冷蔵"), []);
  assert.deepEqual(sp("名称：いかり豆\n原材料名：そら豆、植物油\n保存方法：常温"), []);
  assert.deepEqual(sp("名称：たらの芽の天ぷら\n原材料名：たらの芽、小麦粉\n保存方法：冷凍"), []);
  assert.deepEqual(sp("名称：めんつゆ\n原材料名：しょうゆ、かつおだし、砂糖\n保存方法：常温"), ["水産原料"]);
  const x = usCannedClass(rl2("名称：ビーフカレー\n原材料名：牛肉、たまねぎ\n保存方法：常温\n殺菌方法：レトルト"), { pH: "5.5", Aw: "0.95" });
  assert.equal(x.cls, "肉の量が先");
});
import { euAnimalBand, cnOriginBand } from "../src/rules.js";
test("EU・中国の帯の誤り", () => {
  const f = (i) => euAnimalBand(rl2("名称：x\n原材料名：" + i)).found;
  assert.ok(f("ちりめん、山椒").length > 0);
  assert.ok(f("小麦粉、（一部に乳成分を含む）").includes("乳"));
  assert.deepEqual(f("砂糖、ピーナッツバター"), []);
  assert.deepEqual(f("豆乳、乳化剤、乳酸菌"), []);
  assert.equal(cnOriginBand(rl2("名称：x\n販売者：架空商事 東京都架空区\n製造所：架空食品 静岡県架空市"), {}).state, "原料を聞く");
  assert.equal(cnOriginBand(rl2("名称：x\n販売者：架空商事 東京都架空区\n+AB12"), {}).state, "固有記号");
  assert.equal(cnOriginBand(rl2("名称：x\n製造所：架空 静岡県架空市"), { 主な原料の産地: "不明" }).state, "原料を聞く");
});
