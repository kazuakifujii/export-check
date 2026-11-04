// 総当たりのチェック。決まりノートの行を「1行も飛ばさず」全部判定する。
// 1) 国ごと・箱ごとに行をまとめて Claude に判定させる
// 2) 返ってこなかった行は「分からない」で埋める（漏れをプログラムで防ぐ）
// 3) 数字や地名で決まる行は、プログラムの判定表で上書きする
// 4) 根拠チェック係が、引用がラベルとノートに本当にあるか照らし合わせる
// 5) 「明日やること」を3つに分けて並べる

import { askJson } from "./claude.js";
import { loadNote, rowsForCountry, rowToText, COUNTRIES } from "./note.js";
import { PROGRAM_RULES, usCannedClass } from "./rules.js";
import { verifyJudgement } from "./verify.js";

export const STATUSES = ["ある", "無い", "対象外", "分からない"];
export const TODO_KINDS = ["輸入者に聞く", "日本で取る書類", "出荷ごと", "輸出用の表示で足す", "今の表示・原料を直す", "なし"];

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "row_id", "status", "reason", "label_quote", "absent_on_label",
          "answer_keys", "note_quote", "question", "question_why", "ask_who", "todo_kind", "todo",
        ],
        properties: {
          row_id: { type: "string" },
          status: { type: "string", enum: STATUSES },
          reason: { type: "string", description: "なぜその判定か。輸出が初めての人に分かる言葉で1〜2文" },
          label_quote: { type: "string", description: "根拠にしたラベルの文字。ラベルから一続きにそのまま写す（40字以内、省略記号なし）。無ければ空" },
          absent_on_label: { type: "boolean", description: "「ラベルに書いていない」ことが根拠なら true" },
          answer_keys: { type: "array", items: { type: "string" }, description: "根拠にした答えの項目名" },
          note_quote: { type: "string", description: "根拠にした決まりノートの行の文。行から一続きにそのまま写す（60字以内、省略記号なし）" },
          question: { type: "string", description: "分からないとき、何が分かれば決まるかの質問を1つ。輸出が初めての人がそのまま答えられる言葉で。専門用語・略語・条文番号は使わない（どうしても要るときは括弧で言い換える）。それ以外は空" },
          question_why: { type: "string", description: "分からないとき、なぜそれで決まるのか、答えによってどう変わるかを1〜2文（例：『常温なら〇〇の届け出が要り、ずっと冷蔵なら要りません』）。専門用語は使わない。それ以外は空" },
          ask_who: { type: "string", enum: ["工場の品質管理の担当", "原料の仕入れ先", "相手の国の輸入者", "商社・倉庫", "そのほか", ""], description: "分からないとき、誰に聞けば分かるか。分からない以外は空" },
          todo_kind: { type: "string", enum: TODO_KINDS },
          todo: { type: "string", description: "次にやることを短く1行。無ければ空" },
        },
      },
    },
  },
};

const SYSTEM = `あなたは、日本の食品を海外に輸出するときの「決まりノート」を、1行ずつ当てはめる係です。
渡された決まりノートの行の「すべて」について、この商品・この国で、判定を1つずつ返します。行を飛ばしてはいけません。

判定は次の4つから選びます。
- ある：その行の決まりがこの商品に当てはまり、ラベルか答えで、満たしていることが確かめられる
- 無い：その行の決まりがこの商品に当てはまり、ラベルか答えで、満たしていないことが分かる（表示が足りない、使えない原料が入っている、など）
- 対象外：その行の条件がこの商品に当てはまらない（例：魚を使っていない商品の魚種名の行）、または判定日の時点でまだ施行されていない
- 分からない：決めるのに要る事実が、ラベルにも答えにも無い。このときは、何が分かれば決まるかの質問を1つ書く（行の(4)の質問を使ってよい）

守ること：
- 根拠は、渡したラベルの文字・答え・決まりノートの行の文だけです。あなたの一般知識で決まりを足したり変えたりしません。行の文で決めきれなければ「分からない」にします。
- 日本の表示として正しくても、相手の国の決まりで足りなければ「無い」です。
- 工場の登録や輸入者の手続きなど、ラベルからは分からない行は、答えに書かれていなければ「分からない」です。推測で「ある」にしません。
- 原材料に書いてある物だけでなく、「欄ごと無い項目」（栄養成分表示、原産国、輸入者の住所など）も探します。
- label_quote はラベルの文字を一続きにそのまま写します。note_quote は決まりノートのその行の文を一続きにそのまま写します。どちらも言い換え・省略記号は禁止です。
- todo_kind は、次にやることが誰の・いつの仕事かで選びます。輸入者に確かめること＝輸入者に聞く、日本の工場や役所で取る登録・証明書＝日本で取る書類、荷物ごとの通知や申告＝出荷ごと、何もしなくてよい＝なし。
- 表示の行で「無い」のときは、次の2つを分けます。
  ・輸出用の表示で足す：輸出するときに新しく作る表示（英語や現地語のラベル、オンス併記、米国様式の栄養成分表示、Product of Japan、輸入者の住所、包装の登録番号など）。日本のラベルに無いのは当たり前で、輸出用のラベルを作るときに入れればよいもの。
  ・今の表示・原料を直す：日本のラベルの中身そのもの（原材料の書き方、アレルゲンの抜け、使えない添加物・原料、魚種が決まらない書き方など）を変えないと、輸出用のラベルも正しく作れないもの。
- 日本語の表示は、対象国の言語（英語・販売国の言語・中国語）で書かれているものとして判定します。翻訳した表示は輸出用のラベルを作るときにAIなどで作れるので、言語や翻訳を理由に「無い」にしません。原産国の行（米国 US-P8）も、「原産国：日本」のように中身があれば「ある」、欄ごと無ければ「無い」＋「輸出用の表示で足す」です。言葉の違いより、中身の違い（アレルゲンの対象品目の違い、使えない添加物・着色料、栄養成分の項目や単位、魚の種類の書き方など）を見つけることに集中します。
- アレルゲンの行で、その国の対象の品目が原材料に1つも見当たらなければ「対象外」です（「ある」ではありません）。中身の書かれていない原料（「黒みつ」「調味料」など）の確認は、原料の元を見る行（米国 US-P14 など）に任せます。
- アレルゲンのまとめ書き（「（一部に小麦・大豆を含む）」など）に、原材料にある対象の品目（例：かつお節の魚）が抜けていれば「無い」です。まとめ書きをそのまま英語の Contains 文に訳すと抜けるからです。todo に「Contains を書くなら〇〇も入れる」と書きます。
- 魚の種類の行で、「いわし」「煮干」「ちりめん」のように種が1つに決まらない書き方は「分からない」にし、種名を聞きます。行の文で認められた通称（例：まぐろ＝tuna）で足りるときは「ある」です。
- 工程や原料の産地しだいで決まる行（干し魚の内臓、牛肉の産地など）で、ラベルにも答えにもその事実が無ければ、推測せず「分からない」にして、工程や産地を聞きます。
- 「この行では対象外だが、別の行の決まりがかかる」ときは、reason に確かめる行番号を必ず書きます（例：「混合食品としては対象外。水産加工品の施設の確認は EU-F1 へ」）。
- 「分からない」の質問（question・question_why・ask_who）は、輸出が初めての人が読んで、何を誰に聞けばよいか分かるように書きます。FCE、SID、HACCP、UFI、Prior Notice、第三国リスト、条文番号などの用語は使わず、使うなら「（〇〇のこと）」と言い換えます。
- 答えに「ほかに気になること」があれば、それに関係する行では必ずその点に触れて判定し、reason に「気になること」への答えを書きます（例：英語ラベルを商社の倉庫で貼る→その倉庫も施設の登録が要るか）。「気になること」は事実の答えとして使いますが、「問題ない」と書かれていても、それだけを理由に「ある」にはしません。
- 日本のラベルの原材料名は、重さの多い順に並んでいます（添加物は「／」の後ろ）。ある原料が主原料か・味や中身の中心か・少し使うだけかは、まず原材料の順番と名称（商品名）から判断し、それで決まらないときだけ聞きます（例：名称が「かつお佃煮」や原材料の1番目が魚なら中心。だし・つゆ・スープの素のように、軽くても魚が味の中心なら中心として扱う。調味料の後ろに「かつお節」とあるだけなら少し使うだけの見込みだが、条文に量の基準は無いので「対象外」と言い切らず、reason に「少し使うだけなので当てはまらない見込み」と書く）。
- 文の調子：やわらかく、でも判定ははっきり書きます。reason は「今の扱い → 理由（根拠）」、todo は「次の一歩」を、初めて輸出する人に向けて書きます。「輸入不可」「違反」のような突き放す言い方は避け、「いまの仕様のままでは、〇〇へは出荷できません。〜のためです」「〜を直せば進めます」のように書きます。「大丈夫そう」のように出荷してよいと読める言い方はしません。
- 政治的な言い方はしません。公表された決まりの文だけを根拠にします。`;

function answersToText(answers) {
  const entries = Object.entries(answers || {}).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "（答えはまだありません）";
  return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

async function judgeChunk({ rows, countryName, label, answers, asOf }) {
  const content = [
    {
      type: "text",
      text: `# 判定する国\n${countryName}\n\n# 判定日\n${asOf}\n\n# ラベルの文字（上から順）\n${label.lines
        .map((l, i) => `${i + 1}: ${l}`)
        .join("\n")}\n\n# 読めなかった所\n${label.unreadable.join("\n") || "なし"}\n\n# 作り手の答え\n${answersToText(
        answers,
      )}\n\n# 決まりノートの行（${rows.length}行。全部に答えること）\n\n${rows
        .map(rowToText)
        .join("\n\n---\n\n")}`,
    },
  ];
  const { data, usage } = await askJson({ system: SYSTEM, content, schema: JUDGE_SCHEMA });
  return { results: data.results || [], usage };
}

function chunkRows(rows) {
  const groups = [
    rows.filter((r) => r.box === "入口" || r.box === "施設"),
    rows.filter((r) => r.box === "交差"),
    rows.filter((r) => r.box === "製品"),
  ];
  return groups.filter((g) => g.length > 0);
}

function levelOf(status, row) {
  if (status === "ある") return "問題なし";
  if (status === "対象外") return "対象外";
  if (status === "分からない") return "確認が必要";
  return row.level; // 無い → ノートの(6)に書いた3段階
}

export async function runCheck({ label, countries, answers = {}, asOf, judge = judgeChunk }) {
  asOf = asOf || new Date().toISOString().slice(0, 10);
  const { note } = loadNote();
  const out = { asOf, noteConfirmedOn: note.confirmedOn, countries: {}, usage: { input: 0, output: 0 } };

  const jobs = [];
  for (const c of countries) {
    const rows = rowsForCountry(note, c);
    for (const chunk of chunkRows(rows)) {
      jobs.push(
        judge({ rows: chunk, countryName: COUNTRIES[c], label, answers, asOf }).then((r) => ({ c, ...r })),
      );
    }
  }
  const done = await Promise.all(jobs);

  for (const c of countries) {
    const rows = rowsForCountry(note, c);
    const got = new Map();
    for (const d of done.filter((d) => d.c === c)) {
      out.usage.input += d.usage?.input_tokens || 0;
      out.usage.output += d.usage?.output_tokens || 0;
      for (const r of d.results) if (!got.has(r.row_id)) got.set(r.row_id, r);
    }

    const items = rows.map((row) => {
      let j = got.get(row.id);
      const flags = [];
      if (!j) {
        j = { status: "分からない", reason: "判定が返ってこなかった行です。", question: row.labelOrQuestion, todo_kind: "なし", todo: "" };
        flags.push("AIが答えなかった行（プログラムが「分からない」で埋めました）");
      }
      const programRule = PROGRAM_RULES[row.id];
      const p = programRule ? programRule(label, answers, j) : null;
      if (p) {
        j = { ...j, ...p };
        if (flags[0]?.startsWith("AIが答えなかった")) flags.shift(); // プログラムの判定表で決めた行
      }

      const problems = verifyJudgement(j, row, label, answers);
      let status = j.status;
      if (problems.length > 0) {
        flags.push(...problems);
        status = "分からない";
      }
      const upcoming = row.dates.filter((d) => d.date > asOf);
      const addOn = status === "無い" && j.todo_kind === "輸出用の表示で足す";
      return {
        rowId: row.id,
        box: row.box,
        title: row.title,
        claudeStatus: j.status,
        status,
        level: addOn ? "輸出用に足す" : levelOf(status, row),
        addOn,
        downgraded: problems.length > 0,
        flags,
        reason: j.reason || "",
        labelQuote: j.label_quote || "",
        absentOnLabel: !!j.absent_on_label,
        answerKeys: j.answer_keys || [],
        noteQuote: j.note_quote || j.evidence || "",
        question: status === "分からない" ? j.question || row.labelOrQuestion : "",
        questionWhy: status === "分からない" ? j.question_why || "" : "",
        askWho: status === "分からない" ? j.ask_who || "" : "",
        todoKind: j.todo_kind || "なし",
        todo: j.todo || "",
        decidedBy: j.decidedBy || "claude",
        ifMissing: row.ifMissing,
        workaround: /^未確認/.test(row.workaround) ? "" : row.workaround,
        hard: row.hard,
        source: row.source,
        urls: row.urls,
        weakSource: row.weak,
        marks: row.marks,
        upcoming,
      };
    }).map((i) => ({ ...i, setup: isSetup(i) }));

    const origin = c === "CN" ? items.find((i) => i.rowId === "0-1") : null;
    const stoppedAtEntry = origin && origin.status === "無い" ? origin : null;

    out.countries[c] = {
      name: COUNTRIES[c],
      stoppedAtEntry,
      items,
      summary: summarize(items),
      tomorrow: tomorrowList(items),
      usClass: c === "US" ? usCannedClass(label, answers) : null,
      verdict: verdictOf(items, c === "US" ? usCannedClass(label, answers) : null),
      ifStopped: ifStoppedList(items),
      checkedRows: items.length,
      noteRows: rows.length,
    };
  }
  return out;
}

function summarize(items) {
  const s = { 出せない: 0, 直せば出せる: 0, 確認が必要: 0, 輸出用に足す: 0, 問題なし: 0, 対象外: 0, 段取り: 0 };
  for (const i of items) {
    const k = i.setup ? "段取り" : i.level;
    s[k] = (s[k] || 0) + 1;
  }
  return s;
}

// 出すと決めた後の段取り（出せるかどうかは左右しない行）。「確かめること」から外し、閉じた欄にまとめる
// （藤井さん 11/4「本筋から離れてない？」。線引きは議論で詰める）
export const SETUP_IDS = new Set([
  "US-F2", "US-F3", "US-F7", "US-F9", "US-F11", "US-F12", "US-F14", "US-F15", "US-F16", "US-F17",
  "US-X9", "US-X12", "US-P23",
  "EU-F6",
  "CN-F3", "CN-F5", "CN-F7", "CN-X2", "CN-X5", "CN-X9", "CN-P6", "CN-P9",
]);
export const isSetup = (i) => (SETUP_IDS.has(i.rowId) || isAfterStop(i)) && !["出せない", "対象外"].includes(i.level);

// 止められた後の期限の行は「明日やること」に入れず、「もし港で止められたら」として別に出す（設計の決定 11/4）
const AFTER_STOP_IDS = new Set(["US-F18", "EU-F7", "CN-X7"]);
export const isAfterStop = (i) => AFTER_STOP_IDS.has(i.rowId) || /止められた後|不合格になった後/.test(i.title || "");

function ifStoppedList(items) {
  return items.filter(isAfterStop).map((i) => ({ rowId: i.rowId, title: i.title.replace(/\*\*/g, ""), text: i.todo || i.reason }));
}

// 一番上の見立て（藤井さんの決定 11/4）：入口で無理／現実的に厳しい／回避策がある／進められる見込み
export function verdictOf(items, usClass = null) {
  // 出荷できない条件と、「現実的に厳しい」印の行。加えて、この製品だから必要な要件・入口で、
  // 手続きの負担が大きく回避策のある行（例：米国の低酸性食品→冷蔵で流通）も、見立ての対象にする
  const blocking = items.filter(
    (i) =>
      i.level === "出せない" ||
      (i.hard && ["直せば出せる", "出せない"].includes(i.level)) ||
      (i.level === "直せば出せる" && i.workaround && ["交差", "入口"].includes(i.box)) ||
      // 米国の缶詰・レトルトの区分が低酸性・酸性化食品（見込みを含む）なら、見立てに必ず出す（見せ場）
      (usClass && i.level !== "対象外" && ((usClass.cls === "低酸性缶詰食品" && i.rowId === "US-X1") || (usClass.cls === "酸性化食品" && i.rowId === "US-X2"))),
  );
  if (!blocking.length) return { tier: "進められる見込み", items: [] };
  const noWay = blocking.filter((i) => !i.workaround);
  const entry = noWay.filter((i) => i.box === "入口");
  const pick = (arr) => arr.map((i) => ({ rowId: i.rowId, title: i.title.replace(/\*\*/g, ""), reason: i.reason, workaround: i.workaround, hard: i.hard }));
  if (entry.length) return { tier: "入口で無理", items: pick(entry) };
  if (noWay.length) return { tier: "現実的に厳しい", items: pick(noWay) };
  return { tier: "回避策がある", items: pick(blocking) };
}

function tomorrowList(items) {
  const lists = { 輸入者に聞く: [], 日本で取る書類: [], 出荷ごと: [] };
  for (const i of items) {
    if (i.status === "対象外") continue;
    if (isAfterStop(i) || i.setup) continue;
    if (!lists[i.todoKind]) continue;
    const text = i.todo || i.question;
    if (!text) continue;
    lists[i.todoKind].push({ rowId: i.rowId, text, level: i.level });
  }
  return lists;
}
