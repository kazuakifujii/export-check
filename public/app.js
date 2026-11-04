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
  };
  reader.readAsDataURL(file);
}

$("#sample").addEventListener("click", () => {
  state.image = null;
  $("#preview").hidden = true;
  $("#labelText").value = window.SAMPLES.corn.text;
  $("#labelText").closest("details").open = true;
});

function collectAnswers() {
  const a = {};
  document.querySelectorAll("#answers [data-key]").forEach((el) => {
    if (el.value.trim()) a[el.dataset.key] = el.value.trim();
  });
  return { ...a, ...state.extraAnswers };
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

$("#run").addEventListener("click", () => run(true));

async function run(reread) {
  const countries = [...document.querySelectorAll("input[name=country]:checked")].map((x) => x.value);
  if (!countries.length) return setStatus("国を1つ以上選んでください");
  const btn = $("#run");
  btn.disabled = true;
  try {
    if (reread || !state.label) {
      if (!state.image && !$("#labelText").value.trim()) throw new Error("ラベルの写真か文字を入れてください");
      setStatus("ラベルを読んでいます…");
      state.label = await post("/api/read", state.image ? { image: state.image, mediaType: state.mediaType } : { text: $("#labelText").value });
      renderLabel();
      $("#result").hidden = false;
    }
    setStatus(`決まりノートを1行ずつ当てはめています（${countries.length}か国）… 1分ほどかかります`);
    state.result = await post("/api/check", { label: state.label, countries, answers: collectAnswers(), asOf: $("#asOf").value });
    state.country = state.country && countries.includes(state.country) ? state.country : countries.includes("CN") ? "CN" : countries[0];
    renderResult();
    setStatus("");
  } catch (e) {
    setStatus("うまくいきませんでした：" + e.message);
  } finally {
    btn.disabled = false;
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
const LEVEL_CLASS = { 出せない: "lv-stop", 直せば出せる: "lv-fix", 確認が必要: "lv-ask", 問題なし: "lv-ok", 対象外: "lv-na" };
const BOX_ORDER = [
  ["入口", "入口（最初に見る）", "そもそも、この産地・品目は出してよいか"],
  ["施設", "施設の箱", "どこで作り、扱うか"],
  ["交差", "交差するところ", "この商品を、この工場で。間に落ちやすい"],
  ["製品", "製品の箱", "何を、どう表示するか"],
];

function renderResult() {
  const r = state.result;
  const cs = Object.keys(r.countries);
  $("#countryTabs").innerHTML = cs
    .map((c) => {
      const s = r.countries[c].summary;
      return `<button class="ctab ${c === state.country ? "active" : ""}" data-c="${c}">${esc(r.countries[c].name)}
        <span class="mini lv-stop">${s["出せない"]}</span><span class="mini lv-fix">${s["直せば出せる"]}</span><span class="mini lv-ask">${s["確認が必要"]}</span></button>`;
    })
    .join("");
  document.querySelectorAll(".ctab").forEach((b) => b.addEventListener("click", () => { state.country = b.dataset.c; renderResult(); }));
  renderCountry(r.countries[state.country]);
}

function renderCountry(c) {
  const s = c.summary;
  let html = `<div class="summary">
    <span class="chip lv-stop">出せない ${s["出せない"]}</span>
    <span class="chip lv-fix">直せば出せる ${s["直せば出せる"]}</span>
    <span class="chip lv-ask">確認が必要 ${s["確認が必要"]}</span>
    <span class="chip lv-ok">問題なし ${s["問題なし"]}</span>
    <span class="chip lv-na">対象外 ${s["対象外"]}</span>
    <span class="count">決まりノート ${c.noteRows}行のうち ${c.checkedRows}行を判定（判定日 ${esc(state.result.asOf)}）</span>
  </div>`;

  if (c.stoppedAtEntry) {
    html += `<div class="banner stop"><strong>入口で止まります。</strong>${esc(c.stoppedAtEntry.reason)}
      <br>産地を変えない限り、この国には出せません。下の行は参考として見てください。</div>`;
  }

  html += `<div class="boxes">`;
  for (const [key, name, sub] of BOX_ORDER) {
    const items = c.items.filter((i) => i.box === key);
    if (!items.length) continue;
    const order = ["出せない", "直せば出せる", "確認が必要", "問題なし"];
    const shown = items.filter((i) => i.level !== "対象外").sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
    const na = items.filter((i) => i.level === "対象外");
    html += `<section class="box box-${key}">
      <h3>${name}<small>${sub}</small></h3>
      ${shown.map(card).join("") || `<p class="hint">引っかかる行はありません</p>`}
      ${na.length ? `<details class="na"><summary>対象外 ${na.length}行</summary>${na.map(card).join("")}</details>` : ""}
    </section>`;
  }
  html += `</div>`;

  const qs = c.items.filter((i) => i.status === "分からない" && i.question);
  if (qs.length) {
    html += `<section class="questions"><h3>分かれば決まること（${qs.length}）</h3>
      <p class="hint">分かる所だけ答えて、もう一度チェックできます。</p>
      ${qs.map((i) => `<label class="q"><span><b>${esc(i.rowId)}</b> ${esc(i.question)}</span>
        <input data-q="${esc(i.rowId)}の答え" value="${esc(state.extraAnswers[i.rowId + "の答え"] || "")}"></label>`).join("")}
      <button class="primary" id="rerun">答えて、もう一度チェック</button></section>`;
  }

  html += `<section class="tomorrow"><h3>明日やること</h3><div class="tgrid">`;
  for (const [k, sub] of [["輸入者に聞く", "相手の国の輸入者に確かめる"], ["日本で取る書類", "工場の登録・証明書"], ["出荷ごと", "荷物を出すたびに"]]) {
    const list = c.tomorrow[k];
    html += `<div><h4>${k}<small>${sub}</small></h4><ul>${
      list.length ? list.map((t) => `<li><span class="mini ${LEVEL_CLASS[t.level]}"></span>${esc(t.text)} <em>${esc(t.rowId)}</em></li>`).join("") : "<li class='hint'>なし</li>"
    }</ul></div>`;
  }
  html += `</div></section>`;

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
    run(false);
  });
}

function card(i) {
  const up = i.upcoming.map((d) => `<span class="tag up">${esc(d.label)} ${esc(d.date)}</span>`).join("");
  const weak = i.weakSource ? `<span class="tag weak" title="${esc(i.marks.join(" "))}">出典の照合がまだ</span>` : "";
  const prog = i.decidedBy === "program" ? `<span class="tag prog">判定表で決定</span>` : "";
  const flags = i.flags.length ? `<div class="flags">確認が必要に下げました：${i.flags.map(esc).join("／")}</div>` : "";
  const quote = i.labelQuote ? `<div class="q-label">ラベル：「${esc(i.labelQuote)}」</div>` : i.absentOnLabel ? `<div class="q-label">ラベル：書いていない</div>` : "";
  const answer = i.answerKeys.length ? `<div class="q-label">答え：${i.answerKeys.map(esc).join("、")}</div>` : "";
  const nq = i.noteQuote ? `<div class="q-note">ノート：「${esc(i.noteQuote)}」</div>` : "";
  const link = i.urls[0] ? `<a href="${esc(i.urls[0])}" target="_blank" rel="noopener">出典</a>` : "";
  return `<article class="card ${LEVEL_CLASS[i.level]}" data-quote="${esc(i.labelQuote)}">
    <header><span class="badge ${LEVEL_CLASS[i.level]}">${esc(i.level)}</span><b>${esc(i.rowId)}</b> ${esc(i.title)}</header>
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
