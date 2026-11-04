// Claude に任せず、プログラムで決める判定。
// 数字や地名で決まるものは、ここで決める（毎回同じ答えになるように）。

// 中国が食品の輸入を止めている日本の10都県（決まりノート 0-1）
export const CN_STOPPED_PREFECTURES = [
  "福島", "宮城", "茨城", "栃木", "群馬", "新潟", "埼玉", "千葉", "東京", "長野",
];

const fieldValue = (label, name) =>
  label.fields.filter((f) => f.name.includes(name)).map((f) => f.value).join(" ");

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v).normalize("NFKC").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 中国の入口：産地で止まるか（0-1）
export function judgeChinaOrigin(label, answers) {
  const prefRe = new RegExp(`(${CN_STOPPED_PREFECTURES.join("|")})(都|県)`);
  const answerOrigin = answers["主な原料の産地"] || answers["産地"] || "";
  const maker = [fieldValue(label, "製造者"), fieldValue(label, "製造所")].join(" ");
  const originField = fieldValue(label, "原料原産地");

  const hits = [];
  for (const pref of CN_STOPPED_PREFECTURES) {
    if (answerOrigin.includes(pref)) hits.push({ pref, where: `答え「主な原料の産地：${answerOrigin}」` });
  }
  const mm = maker.match(prefRe);
  if (mm) hits.push({ pref: mm[1], where: `ラベルの製造者の住所「${mm[0]}」` });
  const om = originField.match(prefRe);
  if (om) hits.push({ pref: om[1], where: `ラベルの原料原産地「${om[0]}」` });

  if (hits.length > 0) {
    const name = fieldValue(label, "名称");
    const riceOnly = hits.every((h) => h.pref === "新潟") && /^(精米|玄米|米)$/.test(name.trim());
    if (riceOnly) return null; // 新潟県産の米は産地証明で可（例外）。Claude の判定に任せる
    return {
      status: "無い",
      reason: `中国が輸入を止めている10都県に当たります（${hits.map((h) => h.where).join("、")}）。`,
      evidence: "プログラムの判定表（10都県の一覧）",
      label_quote: mm ? mm[0] : om ? om[0] : "",
      todo_kind: "なし",
      todo: "",
      question: "",
      decidedBy: "program",
    };
  }
  if (answerOrigin) {
    return {
      status: "ある",
      reason: `主な原料の産地（${answerOrigin}）は、止まっている10都県に当たりません。製造所の住所もラベルでは当たりません。`,
      evidence: "プログラムの判定表（10都県の一覧）",
      label_quote: "",
      todo_kind: "日本で取る書類",
      todo: "産地証明書を取る（0-2）",
      question: "",
      decidedBy: "program",
    };
  }
  return null; // 分からない → Claude の判定（たいてい「分からない」と質問）に任せる
}

// 米国の低酸性缶詰食品（US-X1）：pH 4.6 超 かつ 水分活性 0.85 超
export function judgeUsLacf(label, answers) {
  const storage = [answers["保存"] || "", fieldValue(label, "保存方法")].join(" ");
  const sterilize = [answers["殺菌"] || "", fieldValue(label, "殺菌方法"), answers["容器"] || ""].join(" ");
  const pH = num(answers["pH"]);
  const aw = num(answers["Aw"] ?? answers["水分活性"]);

  if (/冷蔵|冷凍|要冷|10℃以下|10°C以下/.test(storage)) {
    return {
      status: "対象外",
      reason: "冷蔵・冷凍で保管・流通する食品は、低酸性缶詰食品の規則の対象外です。ただし、工場から店まで本当に冷蔵かは US-X3 で確かめます。",
      evidence: "プログラムの判定表（冷蔵の例外）",
      label_quote: "",
      todo_kind: "なし",
      todo: "",
      question: "",
      decidedBy: "program",
    };
  }
  if (pH === null || aw === null) return null; // 数値が無ければ Claude（質問）に任せる

  if (pH <= 4.6 || aw <= 0.85) {
    return {
      status: "対象外",
      reason: `pH ${pH}、水分活性 ${aw}。pH 4.6 以下か水分活性 0.85 以下なので、低酸性缶詰食品には当たりません（酸を加えて下げた場合は US-X2 の酸性化食品を確認）。`,
      evidence: "プログラムの判定表（pH 4.6・Aw 0.85）",
      label_quote: "",
      todo_kind: "なし",
      todo: "",
      question: "",
      decidedBy: "program",
    };
  }
  const sealedHeat = /加圧加熱|レトルト|気密性容器|缶|瓶|びん/.test(sterilize);
  if (!sealedHeat) return null;
  const filed = /済|あり|有/.test(answers["LACFの届け出"] || "");
  return {
    status: filed ? "ある" : "無い",
    reason: `pH ${pH}（4.6 超）かつ水分活性 ${aw}（0.85 超）で、密封して加熱殺菌、常温。低酸性缶詰食品に当たります。${
      filed ? "工場登録と工程の届け出は済んでいるとの答えです。" : "工場登録（FCE）と工程の届け出（SID）が要ります。"
    }`,
    evidence: "プログラムの判定表（pH 4.6・Aw 0.85）",
    label_quote: "",
    todo_kind: filed ? "なし" : "日本で取る書類",
    todo: filed ? "" : "プロセスオーソリティに殺菌条件を決めてもらい、FDA に FCE 登録と SID 届け出",
    question: "",
    decidedBy: "program",
  };
}

export const PROGRAM_RULES = {
  "0-1": judgeChinaOrigin,
  "US-X1": judgeUsLacf,
};
