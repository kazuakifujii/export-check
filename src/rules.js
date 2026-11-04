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

// 米国の「缶詰・瓶詰・レトルトの区分」（見せ場。藤井さん 11/4）
// 乾物以外は、低酸性缶詰食品（LACF）／酸性化食品（AF）／冷蔵・冷凍／対象外 のどれかを必ず出す。
// 数値（pH・水分活性）が無い時は「見込み」とし、聞き返す。根拠：21 CFR 113.3・114.3、FDA「LACF/AF Precursor Questions」問1・3・5。
// 酸は酢・クエン酸・酸味料などに絞る（乳酸カルシウム・pH調整剤は酸を加えたことにならない場合が多いので外す）
const ACID_RE = /醸造酢|米酢|穀物酢|りんご酢|黒酢|果実酢|ワインビネガー|酢(?!酸)|クエン酸(?!\s*(Ca|カルシウム|鉄|Na|ナトリウム))|酸味料|酢酸(?!\s*(Na|ナトリウム))|リンゴ酸|乳酸(?!\s*(Ca|カルシウム|菌|Na|ナトリウム))/;
const SEALED_RE = /加圧加熱|レトルト|気密性容器|密封|缶詰|びん詰|瓶詰|殺菌/;
const DRY_RE = /乾燥|乾物|粉末|顆粒|ふりかけ|焙煎|フリーズドライ|スナック|せんべい|煎餅|あられ|クッキー|ビスケット|あめ|飴|削りぶし|削り節|かつお節|鰹節|節$/;
// 区分を出さずに聞く物（114.3(b) の除外や、水分・塩分で決まる物）
const EXCLUDED_RE = /ジャム|マーマレード|プリザーブ|ゼリー/;
const ASK_RE = /みそ|味噌|しょうゆ|醤油|羊羹|ようかん|どら焼|まんじゅう|饅頭|大福|最中|カステラ|和菓子|洋菓子|ケーキ|佃煮|つくだ煮/;
export function usCannedClass(label, answers = {}) {
  const r = usCannedClassCore(label, answers);
  const text = [fieldValue(label, "名称"), fieldValue(label, "品名"), fieldValue(label, "原材料名")].join(" ");
  // 区分とは別に、商品の種類で許可や届け出が要るもの（決まりノート US-X13・X14）
  const also = [];
  if (/果汁|ジュース/.test(text) && r.cls !== "ジュースのHACCP") also.push("果汁を使った飲み物なら、ジュースのHACCP（US-X13）も当たります。");
  if (/清酒|日本酒|焼酎|ビール|ワイン|リキュール|梅酒/.test(text)) also.push("お酒は、輸入者の輸入許可とラベルの承認（US-X14）が要ります。");
  return { ...r, also };
}
function usCannedClassCore(label, answers = {}) {
  const storage = [answers["保存"] || "", fieldValue(label, "保存方法")].join(" ");
  const sterilize = [answers["殺菌"] || "", fieldValue(label, "殺菌方法"), answers["容器"] || ""].join(" ");
  const name = [fieldValue(label, "名称"), fieldValue(label, "品名"), fieldValue(label, "種類別")].join(" ").trim();
  const ingredients = fieldValue(label, "原材料名") || (label.lines || []).join(" ");
  const pH = num(answers["pH"]);
  const aw = num(answers["Aw"] ?? answers["水分活性"]);
  const acid = ACID_RE.test(ingredients);
  const sealedAns = answers["密封・加熱殺菌"] || "";
  const sealed = /はい/.test(sealedAns) || (!/いいえ/.test(sealedAns) && SEALED_RE.test(sterilize));
  const base = { pH, aw, acidInIngredients: acid, needSealedQuestion: false };
  if (/ずっと冷蔵/.test(answers["保存"] || "") || /冷凍/.test(storage) || (/冷蔵|要冷|10℃以下|10°C以下/.test(storage) && !/常温/.test(answers["保存"] || "")))
    return { ...base, cls: "冷蔵・冷凍", sure: true, why: "冷蔵・冷凍で保管・流通・販売する食品は、低酸性・酸性化食品の手続きの対象外です。ただし、店まで本当に冷蔵であることが条件です。" };
  if (aw !== null && aw <= 0.85)
    return { ...base, cls: "対象外", sure: true, why: `水分活性 ${aw}（0.85以下）なので、低酸性・酸性化食品には当たりません。` };
  if (/非加熱/.test(sterilize + " " + name) || /いいえ/.test(sealedAns))
    return { ...base, cls: "対象外", sure: false, why: "密封して加熱殺菌する食品ではない見込みなので、低酸性・酸性化食品には当たりません。" };
  // 肉・卵が中心の物は、米国農務省（USDA）の管轄が先に来ることがある（US-X4・US-X7）
  if (/牛肉|豚肉|鶏肉|ポーク|ビーフ|チキン|ベーコン|ハム|ソーセージ|肉/.test(name + " " + ingredients.split(/[、,]/).slice(0, 3).join(" ")) || /卵|たまご|玉子/.test(name))
    return { ...base, cls: "農務省の管轄の見込み", sure: false, why: "肉や卵が中心の食品は、量によって米国農務省（USDA）の管轄になり、FDAとは別の決まりになります（US-X4・US-X7）。まず肉・卵の量を確かめます。" };
  // 果汁の飲み物は、多くはもともと酸性で、ジュースのHACCP（US-X13）が先に当たる
  if (/ジュース|果汁/.test(name))
    return { ...base, cls: "ジュースのHACCP", sure: false, why: "果汁の飲み物は、低酸性食品ではなく、ジュースのHACCP（US-X13）が当たる見込みです。野菜ジュースなどpHが4.6を超える物は、低酸性食品にも当たります。" };
  if (EXCLUDED_RE.test(name))
    return { ...base, cls: "対象外", sure: false, why: "ジャム・ゼリー類は、酸性化食品の決まりから外されています（21 CFR 114.3(b)）。" };
  if (pH !== null && aw !== null && sealed) {
    if (pH > 4.6) return { ...base, cls: "低酸性缶詰食品", sure: true, why: `pH ${pH}（4.6超）・水分活性 ${aw}（0.85超）の常温の密封・加熱殺菌品です。` };
    if (acid || /はい/.test(answers["酸を加えたか"] || ""))
      return { ...base, cls: "酸性化食品", sure: true, why: `pH ${pH}（4.6以下）ですが、酢などの酸を加えて下げているので、酸性化食品です。` };
    return { ...base, cls: "対象外", sure: false, why: `pH ${pH}（4.6以下）。酸を加えずにもともと酸性なら対象外です（酸を加えていれば酸性化食品）。` };
  }
  if (/^\s*(醸造酢|米酢|穀物酢|りんご酢|黒酢|果実酢|酢)/.test(ingredients))
    return { ...base, cls: "対象外", sure: false, why: "主な原料が酢なので、もともと酸性の食品（酸性食品）の見込みです。pHが4.6以下なら対象外です。" };
  if (DRY_RE.test(name) && !/レトルト|缶詰|びん詰|瓶詰/.test(sterilize))
    return { ...base, cls: "対象外", sure: false, why: "乾燥した食品の見込みです。水分活性が0.85以下なら対象外です。" };
  if (ASK_RE.test(name))
    return { ...base, cls: "分からない", sure: false, needSealedQuestion: !sealed, why: "水分活性（塩分や糖分の多さ）と、密封して加熱殺菌しているかで決まります。" };
  if (sealed) {
    const cls = acid ? "酸性化食品" : "低酸性缶詰食品";
    return { ...base, cls, sure: false, why: acid
      ? "常温で売る密封・加熱殺菌品で、原材料に酢などの酸があります。pHと水分活性で決まります。"
      : "常温で売る密封・加熱殺菌品です。pHと水分活性で決まります。" };
  }
  return { ...base, cls: "分からない", sure: false, needSealedQuestion: true, why: "密封して加熱殺菌しているかと、pH・水分活性で決まります。" };
}
