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

const ALL_PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
  "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
  "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];
const prefName = (p) => p.replace(/(都|府|県)$/, "");
const isStopped = (p) => CN_STOPPED_PREFECTURES.includes(prefName(p));

// ラベルの文字に出てくる都道府県（「長野県」「東京都」のように、県・都・府まで書いてあるもの）
export function prefecturesInText(text) {
  const found = [];
  for (const p of ALL_PREFECTURES) if (text.includes(p)) found.push(p);
  return found;
}

// 中国の入口：産地で止まるか（0-1）
// ・ラベルに出てくる都道府県（製造者・製造所・販売者の住所、原料の産地）と、答えの「主な原料の産地」を集める
// ・全部が止まっている10都県 → 無い（出せない）
// ・10都県と、それ以外が混ざる → 分からない（どの工場・どの原料かを聞く）
// ・答えで産地が分かり、どれも10都県でない → ある
export function judgeChinaOrigin(label, answers) {
  const answerOrigin = answers["主な原料の産地"] || answers["産地"] || "";
  const fromLabel = prefecturesInText(label.fullText);
  const fromAnswer = CN_STOPPED_PREFECTURES.filter((p) => answerOrigin.includes(p)).map((p) => p + "（答え）");
  const answerOk = answerOrigin && fromAnswer.length === 0;

  const stoppedHits = [...fromLabel.filter(isStopped), ...fromAnswer];
  const others = fromLabel.filter((p) => !isStopped(p));

  if (stoppedHits.length > 0) {
    const name = label.fields.filter((f) => /名称|品名/.test(f.name)).map((f) => f.value).join(" ");
    const riceOnly = stoppedHits.every((h) => h.startsWith("新潟")) && /^(精米|玄米|米)$/.test(name.trim());
    if (riceOnly) return null; // 新潟県産の米は産地証明で可（例外）。Claude の判定に任せる
    if (others.length > 0 && fromAnswer.length === 0) {
      return {
        status: "分からない",
        reason: `ラベルに、中国が輸入を止めている10都県（${stoppedHits.join("、")}）と、それ以外（${others.join("、")}）の両方が出てきます。この品がどこで作られ、原料がどこ産かで決まります。`,
        evidence: "プログラムの判定表（10都県の一覧）",
        label_quote: stoppedHits[0],
        question: `この品を作った工場と主な原料は、${stoppedHits.join("・")}ですか、それ以外ですか`,
        todo_kind: "なし",
        todo: "",
        decidedBy: "program",
      };
    }
    return {
      status: "無い",
      reason: `中国が輸入を止めている10都県に当たります（${stoppedHits.join("、")}）。産地を変えない限り、中国へは出せません。`,
      evidence: "プログラムの判定表（10都県の一覧）",
      label_quote: fromLabel.find(isStopped) || "",
      question: "",
      todo_kind: "なし",
      todo: "",
      decidedBy: "program",
    };
  }
  if (answerOk) {
    return {
      status: "ある",
      reason: `主な原料の産地（${answerOrigin}）は、止まっている10都県に当たりません。ラベルの住所にも10都県はありません。`,
      evidence: "プログラムの判定表（10都県の一覧）",
      label_quote: "",
      question: "",
      todo_kind: "日本で取る書類",
      todo: "産地証明書を取る（0-2）",
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

// EU-P2 アレルゲンの強調（太字など）は、EU向けに新しく作る現地語ラベルでの決まり。
// 日本語のラベルを太字に直す必要はないので、不備ではなく「＋α 輸出用に足すもの」として出す。
// 14品目が入っていない（対象外）という判定はそのまま残す。
export function judgeEuEmphasis(label, answers = {}, claude = {}) {
  if (claude.status === "対象外") return null;
  return {
    status: "無い",
    reason: "EUでは、売る国の言葉のラベルで、原材料欄のアレルゲン（小麦・大豆など）を太字などで目立たせる決まりです。日本語のラベルを直す必要はなく、EU向けのラベルを作るときに入れます。",
    label_quote: "",
    question: "",
    todo_kind: "輸出用の表示で足す",
    todo: "EU向けラベルの原材料欄で、アレルゲンを太字などで目立たせる",
    decidedBy: "program",
  };
}

// 表示の言語の行：日本語の表示は対象国の言語で書かれているものとして判定する（作者の決定 11/4）。
// 翻訳した表示案はAIで作れるので、言葉の違いで「見落とし」として並べない。
export function judgeLanguageAssumed() {
  return {
    status: "ある",
    reason: "日本語の表示は、この国の言葉で書かれているものとして判定しています。翻訳した表示は、輸出用のラベルを作るときに作れます（表示案はAIで作れます）。",
    label_quote: "",
    absent_on_label: false,
    question: "",
    todo_kind: "なし",
    todo: "",
    decidedBy: "program",
  };
}

export const PROGRAM_RULES = {
  "US-P7": judgeLanguageAssumed,
  "EU-P1": judgeLanguageAssumed,
  "CN-P1": judgeLanguageAssumed,
  "EU-P2": judgeEuEmphasis,
  "0-1": judgeChinaOrigin,
  "US-X1": judgeUsLacf,
};
