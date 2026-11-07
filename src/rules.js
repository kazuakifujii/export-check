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
const DRY_RE = /乾燥|乾物|粉末|顆粒|ふりかけ|焙煎|フリーズドライ|スナック|せんべい|煎餅|あられ|クッキー|ビスケット|あめ|飴|ボーロ|削りぶし|削り節|かつお節|鰹節|節$/;
// 区分を出さずに聞く物（114.3(b) の除外や、水分・塩分で決まる物）
const EXCLUDED_RE = /ジャム|マーマレード|プリザーブ|ゼリー/;
const ASK_RE = /みそ|味噌|しょうゆ|醤油|羊羹|ようかん|どら焼|まんじゅう|饅頭|大福|最中|カステラ|和菓子|洋菓子|ケーキ|佃煮|つくだ煮/;
// 商品の種類で先に当たる決まり（肉・卵・ジュース・水産・酒）。缶詰の区分とは別に見て、どの区分でも必ず出す
// （冷蔵にしても、農務省やジュース・水産のHACCPは消えない。議論 11/4）
const MEAT_RE = /牛肉|豚肉|鶏肉|鴨肉|羊肉|合挽|合いびき|ひき肉|挽肉|ポーク|ビーフ(?!ン)|(?<!シー)チキン(?!エキス|ブイヨン|コンソメ)|ベーコン|生ハム|(?<!魚肉)ハム(?!スター)|(?<!魚肉)ソーセージ|ウインナー|ジャーキー|サラミ|焼き豚|チャーシュー/;
const FISH_RE = /さば|鯖|いわし|鰯|さんま|秋刀魚|まぐろ|鮪|ツナ|シーチキン|かつお|鰹|鮭|さけ|サーモン|いか|たこ|えび|海老|かに|蟹|ほたて|帆立|あさり|しじみ|かき|牡蠣|魚|しらす|ちりめん|いくら|たらこ|明太|うなぎ|鰻|ぶり|あじ|たら|貝/;
const firstItems = (ing, n) => ing.split(/[、,／/]/).slice(0, n).join(" ");
export function usSpecialRules(label) {
  const name = [fieldValue(label, "名称"), fieldValue(label, "品名")].join(" ");
  const ing = fieldValue(label, "原材料名");
  const text = name + " " + ing;
  const out = [];
  const top = (name + " " + firstItems(ing, 3)).replace(/果肉/g, "");
  if (MEAT_RE.test(top)) out.push({ key: "肉", text: "肉が中心の食品は、肉の量によって米国農務省（USDA）の管轄になり、FDAとは別の決まりになります。まず肉の量を確かめてください（US-X4・US-X7）。" });
  else if (/(牛|豚|鶏|ビーフ|チキン|ポーク|肉)エキス|チキンブイヨン|チキンコンソメ/.test(text)) out.push({ key: "肉エキス", text: "肉のエキスが入っています。量によっては米国農務省（USDA）の管轄になるので、量を確かめてください（US-X4）。" });
  if (/液卵|乾燥卵|冷凍卵|卵黄粉|卵白粉|全卵粉/.test(name)) out.push({ key: "卵", text: "液卵・乾燥卵・冷凍卵は、米国農務省（USDA）の卵製品の決まりに当たる見込みです（US-X4）。" });
  if (isJuiceDrink(name, ing)) out.push({ key: "ジュース", text: /粉末/.test(name) ? "果汁の飲み物の素です。ジュースのHACCP（US-X13）に当たるかを確かめてください。" : "果汁の飲み物には、ジュースのHACCP（US-X13）が当たります。野菜ジュースなどpHが4.6を超える物は、低酸性食品の決まりも重なります。" });
  const fish = fishKind(name, ing);
  if (fish === "中心") out.push({ key: "水産", text: "魚介が中心の食品は、作る工場に水産物のHACCP（US-F8）が当たる見込みです。缶詰の区分とは別にかかります。" });
  else if (fish === "原料") out.push({ key: "水産原料", text: "かつお節などの魚介を使っています。水産物のHACCP（US-F8）は、魚が商品を特徴づける原料の時に当たります（かつおだし・つゆなど）。風味づけに少し使うだけなら、当たらない見込みです（21 CFR 123.3）。" });
  if (/清酒|日本酒|焼酎|ビール|ワイン|リキュール|梅酒/.test(name)) out.push({ key: "酒", text: "お酒は、輸入者の輸入許可とラベルの承認（US-X14）が要ります。" });
  return out;
}
export function usCannedClass(label, answers = {}) {
  let r = usCannedClassCore(label, answers);
  const special = usSpecialRules(label);
  // 肉が中心なら、農務省の管轄が先。管轄が農務省なら、FDAの缶詰の区分は当たらない（決まりノート US-X1 の除外）
  if (special.some((x) => x.key === "肉") && ["低酸性缶詰食品", "酸性化食品"].includes(r.cls))
    r = { ...r, cls: "肉の量が先", sure: false, maybe: r.cls, why: `肉の量で、米国農務省（USDA）の管轄になるかが決まります。農務省の管轄なら、FDAの「${r.cls}」の区分は当たりません。` };
  return { ...r, special, also: special.map((x) => x.text) };
}
// 魚介の判定。短い語（さけ・いか・たら など）は、原材料の1項目そのものか決まった続き方の時だけ（さけるチーズ・いかり豆を拾わない）
const FISH_LONG = /鯛|真鯛|さば|鯖|いわし|鰯|さんま|秋刀魚|まぐろ|鮪|ツナ|シーチキン|かつお(?!節|ぶし|だし|エキス)|鮭|サーモン|ほたて|帆立|あさり|しじみ|牡蠣|しらす|ちりめん|いくら|たらこ|明太|うなぎ|鰻|魚肉|かに肉|白身魚|塩辛|(?<!て)いかの|さけの|鮭の/;
const FISH_SHORT = /^(さけ|いか|たこ|えび|海老|かに|蟹|かき|ぶり|あじ|たら|貝)(水煮|缶|フレーク|フライ|塩辛|燻製|切り身|切身|$)/;
const FISH_DERIVED = /(かつお|鰹|宗田|さば|鯖|いわし|煮干|魚|えび|かに|ほたて|貝|昆布)?(節|ぶし|だし|出汁|エキス|パウダー|粉末|調味料)|魚醤/;
function fishKind(name, ing) {
  const items = ing.split(/[、,／/]/).map((x) => x.replace(/[（(].*?[）)]/g, "").trim()).filter(Boolean);
  const isFish = (x) => !FISH_DERIVED.test(x) && (FISH_LONG.test(x) || FISH_SHORT.test(x));
  const nm = name.trim();
  if ((FISH_LONG.test(nm) && !/せんべい|煎餅|スナック|チーズ/.test(nm)) || FISH_SHORT.test(nm)) return "中心";
  if (items.slice(0, 2).some(isFish) && !/せんべい|煎餅|スナック/.test(nm)) return "中心";
  if (items.some((x) => /(かつお|鰹|宗田|さば|鯖|いわし|煮干|魚介|えび|かに|ほたて)/.test(x) && /(節|ぶし|煮干|だし|出汁|エキス)/.test(x))) return "原料";
  return "";
}
function isJuiceDrink(name, ingredients) {
  if (/グミ|ゼリー|菓子|キャンディ|アイス|ジャム|ポン酢|ぽん酢|たれ|ドレッシング|サイダー|ラムネ|スポーツ/.test(name)) return false;
  if (/ジュース|ネクター|果汁飲料|果実飲料|果汁\s*$/.test(name.trim())) return true;
  const first = ingredients.split(/[、,]/)[0] || "";
  return /飲料|ドリンク/.test(name) && /果汁|ストレート|濃縮還元|ピューレ/.test(first) && !/ぶどう糖/.test(first);
}
function usCannedClassCore(label, answers = {}) {
  // 「開封後は冷蔵」は流通の温度ではないので外す
  const storage = [answers["保存"] || "", fieldValue(label, "保存方法").replace(/開封後[^。]*。?/g, "")].join(" ");
  const sealedLine = (label.lines || []).filter((l) => /気密性容器|加圧加熱|レトルトパウチ|缶詰|びん詰|瓶詰|密封/.test(l)).join(" ");
  const sterilize = [answers["殺菌"] || "", fieldValue(label, "殺菌方法"), fieldValue(label, "密封方法"), sealedLine, answers["容器"] || ""].join(" ");
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
  if (/サイダー|ラムネ|炭酸|ソーダ|コーラ/.test(name))
    return { ...base, cls: "対象外", sure: false, why: "炭酸飲料は、酸性化食品の決まりから外されています（21 CFR 114.3(b)）。" };
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

// EUの見せ場：動物由来の原料（決まりノート EU-X1・EU-F1）。割合による免除は無い
const NF = "(?!風味|香料|フレーバー|味)";
const EU_ANIMAL = [
  [/宗田かつお節|宗田節/, "宗田かつお節"], [/かつお節|鰹節|かつおぶし|かつおふし|かれぶし|削りぶし|かつお粉/, "かつお節"],
  [/さば節|まぐろ節|むろあじ節|いわし節|さばふし|いわしふし|むろあじふし|混合節|雑節/, "ほかの節"], [/煮干|にぼし|いりこ|あご(だし)?(?![a-z])/, "煮干し・いりこ・あご"],
  [/鯛/, "鯛"],
  [new RegExp("(かつお|鰹|魚介|ほたて|えび|かに|いか|さば|いわし|あさり|かき|しじみ|昆布かつお)(エキス|だし|パウダー)" + NF), "魚介のエキス・だし"],
  [/オイスターソース|魚醤|ナンプラー|いしる|しょっつる/, "魚介の調味料"],
  [/かつお(?!節|ぶし|粉|だし|エキス)|鰹(?!節)|ちりめん|しらす|(?<!小)えび|海老|(?<![いた])いか(?!り)|たこ|魚肉|かまぼこ|すり身|魚油|フィッシュコラーゲン|魚コラーゲン|かにかま|なると|数の子|^あさり$|^かき$|いくら|たらこ|明太|魚卵|さけ(?!る)|鮭|まぐろ(?!節)|さば(?!節)/, "魚介"],
  [new RegExp("(チキン|ポーク|ビーフ|牛|豚|鶏|肉)(エキス|ブイヨン|コンソメ|スープ)|豚骨|とんこつ|鶏ガラ|ラード|牛脂|豚脂|ゼラチン|(?<!フィッシュ|魚)コラーゲン" + NF), "肉・骨の原料"],
  [new RegExp("乳製品|脱脂粉乳|全粉乳|(?<!ピーナッツ|ピーナツ|カカオ|ココア|アップル|シア|プラント)バター" + NF + "|チーズ" + NF + "|生クリーム|乳糖|ホエイ|乳たんぱく|牛乳|生乳|練乳|ヨーグルト|マーガリン|乳成分|発酵乳|クリーム(?!チーズ風味)"), "乳"],
  [/卵黄|卵白|全卵|鶏卵|たまご|玉子|(?<!魚|乳化|殻)卵(?!殻)/, "卵"],
  [new RegExp("はちみつ" + NF + "|蜂蜜" + NF + "|ローヤルゼリー|プロポリス"), "はちみつ・蜂の産物"],
];
export function euAnimalBand(label) {
  const raw = fieldValue(label, "原材料名") || label.fullText || "";
  // 「卵不使用」「えび風味」「はちみつ香料」は、その原料が入っている意味ではないので外す
  const ing = raw.replace(/[^、,（）()\s]*(不使用|無添加|風味|香料|フレーバー)/g, "").replace(/(ココナッツ|アーモンド|ひまわり|ピーナッツ|ピーナツ|カカオ|ココア|アップル|シア|プラント)バター|豆乳クリーム|かつお菜/g, "");
  const found = [];
  for (const [re, nm] of EU_ANIMAL) if (re.test(ing) && !found.includes(nm)) found.push(nm);
  if (found.includes("宗田かつお節") && found.includes("かつお節") && !/かつお節/.test(ing.replace(/宗田かつお節/g, ""))) found.splice(found.indexOf("かつお節"), 1);
  if (found.includes("魚介") && found.some((f) => /節|煮干|エキス|調味料/.test(f)) && !/(ちりめん|しらす|えび|海老|いか|たこ|魚肉|かまぼこ|すり身|魚油|フィッシュコラーゲン|魚コラーゲン|かにかま|なると|数の子|^あさり$|^かき$|いくら|たらこ|明太|魚卵|鮭|さけ|鯛|まぐろ(?!節)|さば(?!節)|かつお(?!節|ぶし|粉|だし|エキス))/.test(ing.replace(/宗田かつお節|かつお節/g, ""))) found.splice(found.indexOf("魚介"), 1);
  const FISHY = /節|煮干|魚介|鯛/;
  return { found, fish: found.filter((f) => FISHY.test(f) || f === "宗田かつお節"), other: found.filter((f) => !(FISHY.test(f) || f === "宗田かつお節")) };
}

// 中国の見せ場：最後に加工した工場と主な原料の産地（決まりノート 0-1・0-7・0-9）
export function cnOriginBand(label, answers = {}) {
  // 基準は最後に加工した所（0-7）。販売者の住所では決めない
  const makerFields = label.fields.filter((f) => /製造者|製造所|加工者|加工所/.test(f.name));
  const maker = makerFields.map((f) => f.value).join(" ");
  const uniq = (arr) => [...new Map(arr.map((p) => [prefName(p), p])).values()];
  const makerPrefs = uniq(prefecturesInText(maker));
  let ans = (answers["主な原料の産地"] || answers["産地"] || "").trim();
  if (/不明|分から|わから|未定/.test(ans)) ans = "";
  const ansClean = ans.replace(/(東京|福島|宮城|茨城|栃木|群馬|新潟|埼玉|千葉|長野)(都|県)?(以外|の外)/g, "");
  const ansStopped = CN_STOPPED_PREFECTURES.filter((p) => new RegExp(p + "(都|県|産|の|$|[、,\\s）)])").test(ansClean));
  const codeOnly = !makerPrefs.length && /[+＋][A-Za-z0-9０-９Ａ-Ｚ]{1,10}/.test(label.fullText || "");
  const stopped = uniq([...makerPrefs.filter(isStopped), ...ansStopped.map((p) => p)].map((p) => (p.match(/(都|府|県)$/) ? p : p)));
  const names = [...new Set(stopped.map(prefName))];
  const rice = names.length === 1 && names[0] === "新潟" ? "（新潟県産の米だけは、産地の証明があれば出せます）" : "";
  if (names.length) return { state: "止まる", prefs: names, where: makerPrefs.some(isStopped) ? "工場" : "主な原料", why: `${names.join("・")}は、中国が輸入停止としている10都県に入っています。${rice}` };
  if (makerPrefs.length && ans) return { state: "10都県の外", prefs: makerPrefs, why: `工場は${makerPrefs.join("・")}、主な原料は「${ans}」で、どちらも10都県ではありません。` };
  if (makerPrefs.length) return { state: "原料を聞く", prefs: makerPrefs, why: `製造所は${makerPrefs.join("・")}で、10都県ではありません。最後に加工した所がここか、主な原料の産地も確かめます。` };
  return { state: codeOnly ? "固有記号" : "分からない", prefs: [], why: codeOnly ? "製造所固有記号しか書いていないので、工場の県が分かりません。消費者庁のデータベースで調べるか、販売者に聞いてください。" : "最後に加工した工場と、主な原料の都道府県が分かると決まります（販売者の住所では決まりません）。産地が分からないと、証明書が出ません（農水省）。" };
}
