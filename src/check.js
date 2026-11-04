// 総当たりのチェック。決まりノートの行を「1行も飛ばさず」全部判定する。
// 1) 国ごと・箱ごとに行をまとめて Claude に判定させる
// 2) 返ってこなかった行は「分からない」で埋める（漏れをプログラムで防ぐ）
// 3) 数字や地名で決まる行は、プログラムの判定表で上書きする
// 4) 根拠チェック係が、引用がラベルとノートに本当にあるか照らし合わせる
// 5) 「明日やること」を3つに分けて並べる

import { askJson } from "./claude.js";
import { loadNote, rowsForCountry, rowToText, COUNTRIES } from "./note.js";
import { PROGRAM_RULES } from "./rules.js";
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
          "answer_keys", "note_quote", "question", "todo_kind", "todo",
        ],
        properties: {
          row_id: { type: "string" },
          status: { type: "string", enum: STATUSES },
          reason: { type: "string", description: "なぜその判定か。輸出が初めての人に分かる言葉で1〜2文" },
          label_quote: { type: "string", description: "根拠にしたラベルの文字。ラベルから一続きにそのまま写す（40字以内、省略記号なし）。無ければ空" },
          absent_on_label: { type: "boolean", description: "「ラベルに書いていない」ことが根拠なら true" },
          answer_keys: { type: "array", items: { type: "string" }, description: "根拠にした答えの項目名" },
          note_quote: { type: "string", description: "根拠にした決まりノートの行の文。行から一続きにそのまま写す（60字以内、省略記号なし）" },
          question: { type: "string", description: "分からないとき、何が分かれば決まるかの質問を1つ。それ以外は空" },
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
- 原材料に書いてある物だけでなく、「欄ごと無い項目」（英語の表示、栄養成分表示、輸入者の住所など）も探します。
- label_quote はラベルの文字を一続きにそのまま写します。note_quote は決まりノートのその行の文を一続きにそのまま写します。どちらも言い換え・省略記号は禁止です。
- todo_kind は、次にやることが誰の・いつの仕事かで選びます。輸入者に確かめること＝輸入者に聞く、日本の工場や役所で取る登録・証明書＝日本で取る書類、荷物ごとの通知や申告＝出荷ごと、何もしなくてよい＝なし。
- 表示の行で「無い」のときは、次の2つを分けます。
  ・輸出用の表示で足す：輸出するときに新しく作る表示（英語や現地語のラベル、オンス併記、米国様式の栄養成分表示、Product of Japan、輸入者の住所、包装の登録番号など）。日本のラベルに無いのは当たり前で、輸出用のラベルを作るときに入れればよいもの。
  ・今の表示・原料を直す：日本のラベルの中身そのもの（原材料の書き方、アレルゲンの抜け、使えない添加物・原料、魚種が決まらない書き方など）を変えないと、輸出用のラベルも正しく作れないもの。
- 表示の「言語」（英語・販売国の言語・中国語で書いてあるか）は、言語そのものを決めた行（米国 US-P7、EU EU-P1、中国 CN-P1 など）だけで判定します。それ以外の表示の行（アレルゲン、魚種名、原材料の書き方など）は、書くべき中身がラベルにあるか（日本語でもよい）で判定し、「英語で書いていない」ことを理由に「無い」にはしません。
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
      if (p) j = { ...j, ...p };

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
        todoKind: j.todo_kind || "なし",
        todo: j.todo || "",
        decidedBy: j.decidedBy || "claude",
        ifMissing: row.ifMissing,
        source: row.source,
        urls: row.urls,
        weakSource: row.weak,
        marks: row.marks,
        upcoming,
      };
    });

    const origin = c === "CN" ? items.find((i) => i.rowId === "0-1") : null;
    const stoppedAtEntry = origin && origin.status === "無い" ? origin : null;

    out.countries[c] = {
      name: COUNTRIES[c],
      stoppedAtEntry,
      items,
      summary: summarize(items),
      tomorrow: tomorrowList(items),
      checkedRows: items.length,
      noteRows: rows.length,
    };
  }
  return out;
}

function summarize(items) {
  const s = { 出せない: 0, 直せば出せる: 0, 確認が必要: 0, 輸出用に足す: 0, 問題なし: 0, 対象外: 0 };
  for (const i of items) s[i.level] = (s[i.level] || 0) + 1;
  return s;
}

function tomorrowList(items) {
  const lists = { 輸入者に聞く: [], 日本で取る書類: [], 出荷ごと: [] };
  for (const i of items) {
    if (i.status === "対象外") continue;
    if (!lists[i.todoKind]) continue;
    const text = i.todo || i.question;
    if (!text) continue;
    lists[i.todoKind].push({ rowId: i.rowId, text, level: i.level });
  }
  return lists;
}
