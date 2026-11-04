// 根拠チェック係。Claude の判定ごとに、
//  ・ラベルから引いた言葉が、本当にラベルにあるか
//  ・決まりノートから引いた言葉が、本当にその行にあるか
// をプログラムで照らし合わせる。合わなければ「確認が必要」に下げる。

import { rowToText } from "./note.js";

export function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s、,。．.・「」『』（）()\[\]【】〔〕"'“”‘’…:：;；\/／*＊]/g, "");
}

export function verifyJudgement(j, row, label, answers) {
  const problems = [];
  if (j.decidedBy === "program") return problems;

  const labelText = norm(label.fullText);
  const rowText = norm(rowToText(row));
  const decided = j.status === "ある" || j.status === "無い" || j.status === "対象外";

  if (decided) {
    if (!j.note_quote || !rowText.includes(norm(j.note_quote))) {
      problems.push("決まりノートの行に、引用した文が見つかりません");
    }
  }

  const validAnswerKeys = (j.answer_keys || []).filter((k) => answers[k] !== undefined && answers[k] !== "");
  const badAnswerKeys = (j.answer_keys || []).filter((k) => !validAnswerKeys.includes(k));
  if (badAnswerKeys.length) problems.push(`答えに無い項目を根拠にしています（${badAnswerKeys.join("、")}）`);

  if (j.label_quote && !labelText.includes(norm(j.label_quote))) {
    problems.push(`ラベルに無い言葉を引いています（「${j.label_quote}」）`);
  }

  if (j.status === "ある" || j.status === "無い") {
    const hasEvidence = (j.label_quote && labelText.includes(norm(j.label_quote))) || j.absent_on_label || validAnswerKeys.length > 0;
    if (!hasEvidence) problems.push("ラベルにも答えにも根拠がありません");
  }
  return problems;
}
