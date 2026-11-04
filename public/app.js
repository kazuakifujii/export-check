// 画面の動き。サーバーに「読む」「チェックする」を頼み、結果を三つの箱で見せる。
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = { image: null, mediaType: null, label: null, result: null, country: null, extraAnswers: {} };

// ---------- タブ ----------
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "note") loadNote();
  }),
);

// ---------- 入力 ----------
$("#asOf").value = new Date().toISOString().slice(0, 10);
$("#pick").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (e) => setImage(e.target.files[0]));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setImage(e.dataTransfer.files[0]); });

function setImage(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const [head, data] = reader.result.split(",");
    state.image = data;
    state.mediaType = head.match(/data:(.*);base64/)[1];
    $("#preview").src = reader.result;
    $("#preview").hidden = false;
    $("#labelText").value = "";
    state.labelDirty = true;
  };
  reader.readAsDataURL(file);
}

$("#sample").addEventListener("click", () => {
  state.image = null;
  $("#preview").hidden = true;
  $("#labelText").value = window.SAMPLES.corn.text;
  state.labelDirty = true;
  setStatus("サンプル（架空の「とうもろこしごはんの素」）のラベルを入れました。調べたい国のボタンを押してください。");
});

function collectAnswers() {
  const concern = $("#concern").value.trim();
  return { ...state.extraAnswers, ...(concern ? { ほかに気になること: concern } : {}) };
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

document.querySelectorAll(".runc").forEach((b) => b.addEventListener("click", () => run(!!state.labelDirty, b.dataset.c)));

const COUNTRY_NAMES = { US: "米国", EU: "EU", CN: "中国" };

// 1つの国だけをチェックする。前にチェックした国の結果は残し、タブで見比べられる
async function run(reread, country) {
  const btns = [...document.querySelectorAll(".runc, .nextc")];
  btns.forEach((b) => (b.disabled = true));
  try {
    if (reread || !state.label) {
      if (!state.image && !$("#labelText").value.trim()) throw new Error("ラベルの写真を入れてください");
      setStatus("ラベルを読んでいます…");
      state.label = await post("/api/read", state.image ? { image: state.image, mediaType: state.mediaType } : { text: $("#labelText").value });
      state.labelDirty = false;
      state.result = null; // 新しいラベルなので、前の結果は消す
      renderLabel();
      $("#result").hidden = false;
    }
    setStatus(`${COUNTRY_NAMES[country]}の決まりノートを1行ずつ当てはめています… 1分ほどかかります`);
    state.lastConcern = $("#concern").value.trim();
    const r = await post("/api/check", { label: state.label, countries: [country], answers: collectAnswers(), asOf: $("#asOf").value });
    state.result = { ...r, countries: { ...(state.result?.countries || {}), ...r.countries } };
    state.country = country;
    state.filter = null;
    renderResult();
    setStatus("");
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setStatus("うまくいきませんでした：" + e.message);
  } finally {
    document.querySelectorAll(".runc, .nextc").forEach((b) => (b.disabled = false));
  }
}

function setStatus(t) { $("#status").textContent = t; }

// ---------- ラベル ----------
function renderLabel() {
  $("#labelLines").innerHTML = state.label.lines.map((l, i) => `<li data-i="${i}">${esc(l)}</li>`).join("") +
    (state.label.unreadable?.length ? `<li class="unreadable">読めなかった所：${esc(state.label.unreadable.join("、"))}</li>` : "");
}
const nrm = (s) => String(s || "").normalize("NFKC").replace(/[\s、,。・「」（）()]/g, "");
function highlight(quote) {
  document.querySelectorAll("#labelLines li").forEach((li) => {
    li.classList.toggle("hit", !!quote && nrm(li.textContent).includes(nrm(quote)));
  });
}

// ---------- 結果 ----------
// 画面に出す言葉（中のしくみの名前とは分けて、誤解されにくい言い方にする）
const LEVEL_WORD = { 直せば出せる: "直す所あり（直したら再確認）", 問題なし: "見た範囲では問題なし" };
const levelWord = (l) => LEVEL_WORD[l] || l;
const LEVEL_CLASS = { 出せない: "lv-stop", 直せば出せる: "lv-fix", 確認が必要: "lv-ask", 輸出用に足す: "lv-add", 問題なし: "lv-ok", 対象外: "lv-na" };
const BOX_ORDER = [
  ["入口", "そもそも、この国に出せるか", "産地や品目で、国として受け入れを止めているもの"],
  ["製品", "製品の要件", "何を、どう表示するか"],
  ["交差", "交差するところ", "この商品を、この工場で"],
  ["施設", "施設の要件", "どこで作り、扱うか"],
];

// 聞き返しのうち、決まった形で答えてもらう項目（理由も一緒に見せる）
const QUESTION_FIELDS = {
  "0-1": [{ key: "主な原料の産地", label: "工場と主な原料の都道府県", placeholder: "例：工場は北海道、原料も北海道", why: "中国は、日本の10都県（福島・宮城・茨城・栃木・群馬・新潟・埼玉・千葉・東京・長野）の食品の輸入を止めています。この10都県に入るかを確かめるためだけに使います。" }],
  "US-X1": [
    { key: "pH", label: "完成品の pH（品質管理の担当に測った値を聞いてください）", placeholder: "例：5.8", why: "米国では、pH 4.6 を超え、かつ水分活性 0.85 を超える常温の密封・加熱殺菌品は「低酸性缶詰食品」になり、工場の登録と殺菌工程の届け出が要ります。2つそろって判定できます。" },
    { key: "Aw", label: "完成品の水分活性（Aw）", placeholder: "例：0.97" },
  ],
  "US-X2": [{ key: "pH", label: "完成品の pH", placeholder: "例：4.2" }],
  "US-X3": [{ key: "保存", label: "工場から店までの温度", select: ["ずっと冷蔵", "途中で常温に置く時間がある", "常温"], why: "冷蔵で流通する食品は、米国の低酸性缶詰食品の決まりから外れます。ただし、表示ではなく実際にずっと冷蔵かで決まります。" }],
  "US-X5": [{ key: "英語ラベルを貼る場所", label: "英語ラベルを貼る場所", placeholder: "例：商社の倉庫（日本）", why: "ラベル貼りだけをする倉庫も、米国の施設登録が要るからです。" }],
};
function renderResult() {
  const r = state.result;
  const cs = Object.keys(r.countries);
  $("#countryTabs").innerHTML = cs
    .map((c) => {
      const s = r.countries[c].summary;
      return `<button class="ctab ${c === state.country ? "active" : ""}" data-c="${c}">${esc(r.countries[c].name)}
        <span class="mini lv-stop" data-lv="出せない" title="押すと、出せない所だけを表示">${s["出せない"]}</span><span class="mini lv-fix" data-lv="直せば出せる" title="押すと、直す所だけを表示">${s["直せば出せる"]}</span><span class="mini lv-ask" data-lv="確認が必要" title="押すと、確認が必要な所だけを表示">${s["確認が必要"]}</span></button>`;
    })
    .join("");
  const rest = Object.keys(COUNTRY_NAMES).filter((c) => !cs.includes(c));
  if (rest.length) {
    $("#countryTabs").innerHTML += `<span class="next">次の輸出先でチェックする：${rest
      .map((c) => `<button class="ghost nextc" data-c="${c}">${COUNTRY_NAMES[c]}</button>`)
      .join("")}</span>`;
  }
  document.querySelectorAll(".ctab").forEach((b) => b.addEventListener("click", () => { state.country = b.dataset.c; state.filter = null; renderResult(); }));
  document.querySelectorAll(".nextc").forEach((b) => b.addEventListener("click", () => run(false, b.dataset.c)));
  renderCountry(r.countries[state.country]);
}

function renderCountry(c) {
  const s = c.summary;
  const f = state.filter;
  const chip = (lv, word) =>
    `<button class="chip ${LEVEL_CLASS[lv]} ${f === lv ? "on" : ""} ${f && f !== lv ? "dim" : ""}" data-lv="${lv}" title="押すと、これだけを表示します" ${s[lv] ? "" : "disabled"}>${word} ${s[lv]}</button>`;
  let html = `<div class="summary">
    ${chip("出せない", "出せない")}${chip("直せば出せる", "直す所あり")}${chip("確認が必要", "確認が必要")}${chip("輸出用に足す", "輸出用に足す")}${chip("問題なし", "見た範囲では問題なし")}${chip("対象外", "対象外")}
    <span class="count">決まりノート ${c.noteRows}行のうち ${c.checkedRows}行を判定（判定日 ${esc(state.result.asOf)}）</span>
  </div>`;

  if (c.stoppedAtEntry) {
    html += `<div class="banner stop"><strong>入口で止まります。</strong>${esc(c.stoppedAtEntry.reason)}
      <br>産地を変えない限り、この国には出せません。下の行は参考として見てください。</div>`;
  }

  if (f) {
    html += `<div class="filterbar">「${esc(levelWord(f))}」だけを表示しています（${s[f]}件） <button class="ghost" id="showAll">すべて表示に戻す</button></div>`;
  }
  html += conceptMap();
  html += `<div class="boxes">`;
  for (const [key, name, sub] of BOX_ORDER) {
    const items = c.items.filter((i) => i.box === key);
    if (!items.length) continue;
    if (f) {
      const only = items.filter((i) => i.level === f);
      if (only.length) html += `<section class="box box-${key}"><h3>${name}<small>${sub}</small></h3>${only.map(card).join("")}</section>`;
      continue;
    }
    const order = ["出せない", "直せば出せる", "確認が必要", "問題なし"];
    const shown = items.filter((i) => order.includes(i.level)).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
    const add = items.filter((i) => i.level === "輸出用に足す");
    const na = items.filter((i) => i.level === "対象外");
    html += `<section class="box box-${key}">
      <h3>${name}<small>${sub}</small></h3>
      ${shown.map(card).join("") || `<p class="hint">引っかかる所はありません</p>`}
      ${add.length ? `<details class="addon"><summary>＋α 輸出用のラベルを作るときに足すもの（${add.length}）</summary>
        <p class="hint">日本のラベルに無いのは当たり前のものです。輸出用のラベルを作るときに入れてください。</p>${add.map(card).join("")}</details>` : ""}
    </section>`;
  }
  html += `</div>`;

  const qs = c.items.filter((i) => i.status === "分からない" && i.question);
  if (qs.length) {
    const usedKeys = new Set();
    const rowsHtml = qs.map((i) => {
      const fields = (QUESTION_FIELDS[i.rowId] || []).filter((f) => !usedKeys.has(f.key));
      fields.forEach((f) => usedKeys.add(f.key));
      if (QUESTION_FIELDS[i.rowId] && fields.length === 0) return "";
      const inputs = fields.length
        ? fields.map((f) => `<label class="qf"><span>${esc(f.label)}</span>${
            f.select
              ? `<select data-q="${esc(f.key)}"><option value=""></option>${f.select.map((o) => `<option ${state.extraAnswers[f.key] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
              : `<input data-q="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}" value="${esc(state.extraAnswers[f.key] || "")}">`
          }</label>`).join("")
        : `<input data-q="${esc(i.rowId)}の答え" value="${esc(state.extraAnswers[i.rowId + "の答え"] || "")}">`;
      const why = fields.map((f) => f.why).filter(Boolean).join(" ") || i.questionWhy || i.reason;
      return `<div class="q"><div>
        <div class="q-topic">${explain(plainTitle(i.title))} <small>${esc(i.rowId)}</small></div>
        <div class="q-ask">${explain(i.question)}</div>
        ${why ? `<div class="why"><b>なぜ聞くか：</b>${explain(why)}</div>` : ""}
        ${i.askWho ? `<div class="why"><b>誰に聞けば分かるか：</b>${esc(i.askWho)}</div>` : ""}
      </div><div class="qin">${inputs}</div></div>`;
    }).join("");
    html += `<section class="questions"><h3>教えてもらえれば決まること（${qs.length}）</h3>
      <p class="hint">この商品のことで、ラベルからは読めず、判定が決まらなかった所です。分かる所だけ答えて、もう一度チェックできます。分からない所は空のままで大丈夫です（その行は「確認が必要」のまま残ります）。点線の下線の言葉は、マウスを乗せると意味が出ます。</p>
      ${rowsHtml}
      <button class="primary" id="rerun">答えて、もう一度チェック</button></section>`;
  }

  html += `<section class="tomorrow"><h3>明日やること</h3><div class="tgrid">`;
  for (const [k, sub] of [["輸入者に聞く", "相手の国の輸入者に確かめる"], ["日本で取る書類", "工場の登録・証明書"], ["出荷ごと", "荷物を出すたびに"]]) {
    const list = c.tomorrow[k];
    html += `<div><h4>${k}<small>${sub}</small></h4><ul>${
      list.length ? list.map((t) => `<li><span class="mini ${LEVEL_CLASS[t.level]}"></span>${esc(t.text)} <em>${esc(t.rowId)}</em></li>`).join("") : "<li class='hint'>なし</li>"
    }</ul></div>`;
  }
  html += `</div>`;
  if (c.ifStopped?.length) {
    html += `<details class="ifstopped"><summary>もし港で止められたら（${c.ifStopped.length}）</summary><ul>${c.ifStopped
      .map((t) => `<li><b>${esc(t.title)}</b>：${explain(t.text)} <em>${esc(t.rowId)}</em></li>`)
      .join("")}</ul></details>`;
  }
  html += `</section>`;

  const concern = state.lastConcern;
  if (concern) {
    html += `<section class="questions"><h3>書いてもらった「気になること」</h3><p>${esc(concern)}</p>
      <p class="hint">決まりノートの行に関係する所は、その行の判定の理由に書いています。ノートに無いことは判定できないので、窓口（JETRO など）で確かめてください。</p></section>`;
  }
  // 当てはまらない決まりは、全部見た証拠として一番下に畳んで置く
  const naAll = c.items.filter((i) => i.level === "対象外");
  if (naAll.length && !f) {
    html += `<details class="na naall"><summary>この商品に当てはまらない決まり ${naAll.length}件（開く）</summary>
      <p class="hint">決まりノートの行は全部当てはめています。ここは、この商品には関係しないと判定した行です。</p>${naAll.map(card).join("")}</details>`;
  }
  $("#countryBody").innerHTML = html;
  document.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("mouseenter", () => highlight(el.dataset.quote));
    el.addEventListener("mouseleave", () => highlight(""));
  });
  const rerun = $("#rerun");
  if (rerun) rerun.addEventListener("click", () => {
    document.querySelectorAll("[data-q]").forEach((el) => {
      if (el.value.trim()) state.extraAnswers[el.dataset.q] = el.value.trim();
      else delete state.extraAnswers[el.dataset.q];
    });
    run(false, state.country);
  });
}

// 用語の言い換え。画面の文に出てきたら、点線の下線とマウスを乗せたときの説明をつける
const GLOSSARY = {
  "FCE": "米国FDAへの、缶詰・レトルト食品の工場の登録",
  "SID": "米国FDAへの、殺菌の条件（温度・時間）の届け出",
  "LACF": "低酸性缶詰食品。酸っぱくなく水分の多い、密封・加熱殺菌の常温食品",
  "低酸性缶詰食品": "酸っぱくなく水分の多い（pH 4.6超・水分活性0.85超）、密封・加熱殺菌の常温食品。米国で特別の届け出が要る",
  "酸性化食品": "酢などを加えて酸っぱくした（pHを下げた）食品。米国で届け出が要る",
  "HACCP": "原料から出荷までの危ない所を決めて、記録しながら管理するやり方",
  "UFI": "施設ごとの番号。米国では DUNS番号（会社・工場の番号）を使う",
  "DUNS": "会社・工場ごとの番号（無料で取れる）",
  "Prior Notice": "米国に荷物を送る前の、FDAへの事前の知らせ（出荷ごと）",
  "FSVP": "米国の輸入者が、輸入する食品の安全を確かめる決まり",
  "第三国リスト": "EUが、この国のこの原料なら入れてよいと認めた国の一覧",
  "混合食品": "植物の原料と、加工した動物の原料（魚・肉・乳・卵など）を合わせた食品",
  "水分活性": "食品の中の、微生物が使える水の量の目安（0〜1）。高いほど傷みやすい",
  "Aw": "水分活性。食品の中の、微生物が使える水の量の目安（0〜1）",
  "pH": "酸っぱさの目安。小さいほど酸っぱい（4.6以下だと菌が増えにくい）",
  "プロセスオーソリティ": "殺菌の条件が十分かを決める専門家・機関",
  "輸入警告": "米国FDAが、検査なしで止めてよいと決めた商品・会社の一覧",
  "Contains": "米国の英語ラベルで、アレルゲンをまとめて書く「含む：〜」の文",
};
const GLOSS_RE = new RegExp(Object.keys(GLOSSARY).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
function explain(text) {
  const seen = new Set();
  return esc(text || "").replace(GLOSS_RE, (m) => {
    if (seen.has(m)) return m;
    seen.add(m);
    return `<abbr class="gl" title="${esc(GLOSSARY[m])}">${m}</abbr>`;
  });
}
// 行の題から、英語の略語や条文番号のかっこを外して読みやすくする
function plainTitle(t) {
  return String(t || "").replace(/\*\*/g, "").replace(/（[A-Za-z0-9 .\-=／/]+）/g, "").trim();
}

// 3つの要件の概念図（例つき）。結果の上に出して、各行がどこに入るかを分かるようにする
function conceptMap() {
  return `<figure class="concept">
    <div class="cbox c-製品"><b>製品の要件</b><small>何を、どう表示するか</small>
      <ul><li>アレルゲン（魚種、ごま）</li><li>着色料</li><li>栄養成分の様式</li><li>オンスの併記</li></ul></div>
    <div class="carrow">→</div>
    <div class="cbox c-交差"><b>交差するところ</b><small>この商品を、この工場で</small>
      <ul><li>米国：低酸性食品<br>→ 工程の届け出<br>→ 講習済みの責任者</li><li>EU：鰹節の出どころ<br>→ 認定施設のものか</li></ul></div>
    <div class="carrow">←</div>
    <div class="cbox c-施設"><b>施設の要件</b><small>どこで作り、扱うか</small>
      <ul><li>食品施設の登録</li><li>ラベル貼りや倉庫も</li><li>米国内の代理人</li><li>衛生管理の計画</li></ul></div>
    <figcaption>決まりは、この3つのどれかに入ります。いちばん見落としやすいのは真ん中の「交差するところ」。商品の中身と、作る工場の組み合わせで初めて決まるので、表示の担当にも工場の担当にも見えにくい所です。</figcaption>
  </figure>`;
}

function card(i) {
  const up = i.upcoming.map((d) => `<span class="tag up">${esc(d.label)} ${esc(d.date)}</span>`).join("");
  const weak = i.weakSource ? `<span class="tag weak" title="${esc(i.marks.join(" "))}">根拠の条文・当局資料は未確認</span>` : "";
  const prog = i.decidedBy === "program" ? `<span class="tag prog">決まった計算で判定</span>` : "";
  const flags = i.flags.length ? `<div class="flags">言い切れないので「確認が必要」にしました：${i.flags.map(esc).join("／")}</div>` : "";
  const quote = i.labelQuote ? `<div class="q-label">ラベル：「${esc(i.labelQuote)}」</div>` : i.absentOnLabel ? `<div class="q-label">ラベル：書いていない</div>` : "";
  const answer = i.answerKeys.length ? `<div class="q-label">答え：${i.answerKeys.map(esc).join("、")}</div>` : "";
  const nq = i.noteQuote ? `<div class="q-note">ノート：「${esc(i.noteQuote)}」</div>` : "";
  const link = i.urls[0] ? `<a href="${esc(i.urls[0])}" target="_blank" rel="noopener">出典</a>` : "";
  return `<article class="card ${LEVEL_CLASS[i.level]}" data-quote="${esc(i.labelQuote)}">
    <header><span class="badge ${LEVEL_CLASS[i.level]}">${esc(levelWord(i.level))}</span><b>${esc(i.rowId)}</b> ${explain(plainTitle(i.title))}</header>
    <p>${esc(i.reason)}</p>
    ${quote}${answer}${nq}${flags}
    ${i.todo ? `<div class="todo">次に：${esc(i.todo)}</div>` : ""}
    <footer>判定：${esc(i.status)} ${prog}${weak}${up} ${link}</footer>
  </article>`;
}

// ---------- 決まりノート ----------
let noteCache = null;
async function loadNote() {
  if (!noteCache) noteCache = await (await fetch("/api/note")).json();
  $("#noteMeta").textContent = `${noteCache.file}／確認日 ${noteCache.confirmedOn || "—"}／${noteCache.rows.length}行`;
  renderNote("");
}
$("#noteSearch").addEventListener("input", (e) => renderNote(e.target.value));
function renderNote(q) {
  const names = { US: "米国", EU: "EU", CN: "中国" };
  const rows = noteCache.rows.filter((r) => !q || JSON.stringify(r).includes(q));
  $("#noteTable").innerHTML = `<table class="note"><thead><tr><th>#</th><th>国</th><th>箱</th><th>要件</th><th>条件</th><th>例外</th><th>ラベルで？／質問</th><th>足りないとき</th><th>出典</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.id)}</td><td>${names[r.country] || ""}</td><td>${esc(r.box)}</td><td>${esc(r.title)}</td><td>${esc(r.condition)}</td><td>${esc(r.exception)}</td><td>${esc(r.labelOrQuestion)}</td><td><span class="badge ${LEVEL_CLASS[r.level]}">${esc(r.level)}</span> ${esc(r.ifMissing)}</td><td class="src">${esc(r.source)}</td></tr>`)
    .join("")}</tbody></table>`;
}

// 件数の丸（国のタブ・まとめの札）を押すと、その段階の行だけを表示する。もう一度押すと元に戻る
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".summary .chip[data-lv]");
  const mini = e.target.closest(".ctab .mini[data-lv]");
  const all = e.target.closest("#showAll");
  if (!chip && !mini && !all) return;
  if (mini) {
    e.stopPropagation();
    state.country = mini.closest(".ctab").dataset.c;
    state.filter = mini.dataset.lv;
  } else if (chip) {
    state.filter = state.filter === chip.dataset.lv ? null : chip.dataset.lv;
  } else {
    state.filter = null;
  }
  renderResult();
}, true);
