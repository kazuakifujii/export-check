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
const LEVEL_WORD = {
  出せない: "出荷できない条件があります",
  直せば出せる: "直す所があります",
  確認が必要: "確かめること",
  輸出用に足す: "輸出用ラベルで足す所",
  問題なし: "確認した範囲では問題は見つかっていません",
  対象外: "この商品には当てはまらない項目",
};
const levelWord = (l) => LEVEL_WORD[l] || l;
const LEVEL_CLASS = { 出せない: "lv-stop", 直せば出せる: "lv-fix", 確認が必要: "lv-ask", 輸出用に足す: "lv-add", 問題なし: "lv-ok", 対象外: "lv-na" };
const BOX_ORDER = [
  ["入口", "そもそも、この国に出せるか", "産地や品目で、国として受け入れを止めているもの"],
  ["製品", "製品の要件", "何を、どう表示するか"],
  ["交差", "この製品だから必要な要件", "原料や作り方で、工場や仕入先に求められることが変わる"],
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
  if (state.view === "label") renderAnnotated();
  else renderCountry(r.countries[state.country]);
  $("#countryBody").insertAdjacentHTML("afterbegin", `<div class="viewsw"><button class="ghost ${state.view !== "label" ? "on" : ""}" data-v="table">チェック表で見る</button><button class="ghost ${state.view === "label" ? "on" : ""}" data-v="label">ラベルに書き込んで見る</button></div>`);
  document.querySelectorAll(".viewsw button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.v; renderResult(); }));
}

// 枠に指摘が無い時の文。判定が欠けた時や入口で止まった時は「指摘なし」と読ませない（議論 11/4：事故につながる）
function emptyBox(c, key, naCount) {
  const boxItems = c.items.filter((i) => i.box === key);
  const unjudged = boxItems.some((i) => (i.flags || []).some((f) => f.startsWith("AIが答えなかった")));
  if (c.stoppedAtEntry || c.verdict?.tier === "入口で無理") return `<p class="hint">入口の条件に当たったので、くわしい確認はしていません。</p>`;
  if (unjudged || !boxItems.length) return `<p class="hint">この枠は、判定がそろっていません。もう一度チェックしてください。</p>`;
  return `<p class="none-box">今回の確認では、特に指摘はありません。未確認の条件は、別に確かめてください。${naCount ? `（当てはまらない項目 ${naCount}件は、下にまとめています）` : ""}</p>`;
}

function renderCountry(c) {
  const s = c.summary;
  const f = state.filter;
  const chip = (lv, word) =>
    `<button class="chip ${LEVEL_CLASS[lv]} ${f === lv ? "on" : ""} ${f && f !== lv ? "dim" : ""}" data-lv="${lv}" title="押すと、これだけを表示します" ${s[lv] ? "" : "disabled"}>${word} ${s[lv]}</button>`;
  let html = outlook(c) + `<div class="summary">
    ${chip("出せない", "出荷できない条件")}${chip("直せば出せる", "直す所")}${chip("確認が必要", "確かめること")}
    <span class="sep"></span>${chip("輸出用に足す", "輸出用ラベルで足す所")}${chip("問題なし", "問題は見つかっていない")}${chip("対象外", "当てはまらない")}
    <span class="count">決まりノート ${c.noteRows}行のうち ${c.checkedRows}行を判定（判定日 ${esc(state.result.asOf)}）</span>
  </div>
  <div class="guide">
    ${s["出せない"] ? `<p><b class="g-stop">出荷できない条件があります（${s["出せない"]}）</b>　理由と、進むための条件を見ましょう。</p>` : ""}
    ${s["直せば出せる"] ? `<p><b class="g-fix">直す所があります（${s["直せば出せる"]}）</b>　表示の修正、または登録・証明書の取得です。直したら、もう一度確かめます。</p>` : ""}
    ${s["確認が必要"] ? `<p><b class="g-ask">確かめること（${s["確認が必要"]}）</b>　誰に聞けばよいかも示します。</p>` : ""}
    ${s["出せない"] + s["直せば出せる"] + s["確認が必要"] ? `<p class="hint">これらが片づくまでは出荷を待ち、輸入者と確かめましょう。</p>` : `<p class="hint">決まりノートで見た範囲では、引っかかる所は見つかっていません。出荷の前に、輸入者と窓口で確かめてください。</p>`}
  </div>`;

  if (c.stoppedAtEntry) {
    html += `<div class="banner stop"><strong>この国への入口で、確かめる条件があります。</strong>${esc(c.stoppedAtEntry.reason)}
      <br>この産地のままでは、この国へは出荷できない条件があります。下の行は、産地を変えた場合の参考として見てください。</div>`;
  }

  if (f) {
    html += `<div class="filterbar">「${esc(levelWord(f))}」だけを表示しています（${s[f]}件） <button class="ghost" id="showAll">すべて表示に戻す</button></div>`;
  }
  html += `<div class="boxes">`;
  for (const [key, name, sub] of BOX_ORDER) {
    const items = c.items.filter((i) => i.box === key && !i.setup);
    // 製品・交差・施設の枠は、当てはまる物が無くても残す（「懸念が見つかっていない」と伝わるように。藤井さん 11/4）
    if (!items.length && key === "入口") continue;
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
      ${shown.map(card).join("") || emptyBox(c, key, na.length)}
      ${add.length ? `<details class="addon"><summary>＋α 輸出用ラベルで足す所（${add.length}）</summary>
        <p class="hint">日本のラベルに無いのは当たり前のものです。輸出用のラベルを作るときに入れてください。</p>${add.map(card).join("")}</details>` : ""}
    </section>`;
  }
  html += `</div>`;

  const qs = c.items.filter((i) => i.status === "分からない" && i.question && !i.setup).sort((x, y) => qPriority(x, state.country) - qPriority(y, state.country));
  if (qs.length) {
    const usedKeys = new Set();
    const groups = new Map();
    const firstThree = [];
    qs.forEach((i) => {
      const fields = (QUESTION_FIELDS[i.rowId] || []).filter((f) => !usedKeys.has(f.key));
      fields.forEach((f) => usedKeys.add(f.key));
      if (QUESTION_FIELDS[i.rowId] && fields.length === 0) return;
      const inputs = fields.length
        ? fields.map((f) => `<label class="qf"><span>${esc(f.label)}</span>${
            f.select
              ? `<select data-q="${esc(f.key)}"><option value=""></option>${f.select.map((o) => `<option ${state.extraAnswers[f.key] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
              : `<input data-q="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}" value="${esc(state.extraAnswers[f.key] || "")}">`
          }</label>`).join("")
        : `<input data-q="${esc(i.rowId)}の答え" list="ansChoices" placeholder="分かれば書く／選ぶ" value="${esc(state.extraAnswers[i.rowId + "の答え"] || "")}">`;
      const why = fields.map((f) => f.why).filter(Boolean).join(" ") || i.questionWhy || i.reason;
      const who = whoGroup(i.askWho, i.todoKind);
      if (firstThree.length < 3) { firstThree.push(qHtml(i, inputs, why, who)); return; }
      if (!groups.has(who)) groups.set(who, []);
      groups.get(who).push(`<div class="q"><div>
        <div class="q-topic">${explain(plainTitle(i.title))} <small>${esc(i.rowId)}</small></div>
        <div class="q-ask">${explain(i.question)}</div>
        ${why ? `<div class="why"><b>なぜ聞くか：</b>${explain(why)}</div>` : ""}
      </div><div class="qin">${inputs}</div></div>`);
    });
    const order = [...WHO_GROUPS.map((g) => g[0]), "そのほか"];
    const rowsHtml = order.filter((w) => groups.has(w)).map((w) =>
      `<details class="qgroup"><summary>${esc(w)}に聞く ${groups.get(w).length}つ</summary>${groups.get(w).join("")}</details>`).join("");
    const firstHtml = firstThree.join("");
    const decided = c.items.length - qs.length;
    const rest = qs.length - firstThree.length;
    html += `<section class="questions"><h3>明日やること：だれに、何を聞くか</h3>
      <p class="progress">まずこの${firstThree.length}件です${rest > 0 ? `（残り${rest}件）` : ""}。</p>
      <p class="hint">一人で全部答えなくて大丈夫。分かった所から入れてください。</p>
      ${firstHtml}
      ${rest > 0 ? `<p class="hint" style="margin-top:12px">残りは、聞く相手ごとにまとめています。</p>` : ""}
      ${rowsHtml}
      <button class="primary" id="rerun">答えて、もう一度チェック</button></section>`;
  }

  // 明日やること：出せるかどうかを決めるために、誰に何を聞くか・取るか。段取りは下の「出すと決めたら」へ。
  // 文は短い見出しだけ。くわしい「やること」は開いたら見える（藤井さん 11/4：書き方の工夫）
  const tm = c.items.filter((i) => !i.setup && i.level !== "対象外" && i.level !== "問題なし" && !isAfterStopItem(i));
  // 聞くことは上の「明日やること」にまとめた。ここは日本で取る登録・書類（出せるかに関わるもの）だけ
  const docs = tm.filter((i) => i.todoKind === "日本で取る書類" && !(i.status === "分からない" && i.question))
    .sort((x, y) => (ORDER_LV[x.level] ?? 9) - (ORDER_LV[y.level] ?? 9));
  const li = (i) => `<li><details><summary><span class="mini ${LEVEL_CLASS[i.level]}"></span>${explain(plainTitle(i.title))}</summary><div class="hint">${explain(i.todo || "")} <span class="rid">${esc(i.rowId)}</span></div></details></li>`;
  html += `<section class="tomorrow">`;
  if (docs.length) html += `<h3>日本で取る登録・書類</h3><p class="hint">出せるかどうかに関わるものです。</p><ul class="docs">${docs.slice(0, 5).map(li).join("")}${docs.length > 5 ? `<li class="hint">ほか${docs.length - 5}件（上の表で）</li>` : ""}</ul>`;
  // 出すと決めた後の段取り。出せるかどうかは左右しないので、閉じておく
  const setup = c.items.filter((i) => i.setup);
  if (setup.length && !f) {
    html += `<details class="ifstopped setup"><summary>出すと決めたら：出荷の段取り（${setup.length}件。出荷には、このほかにも手続きがあります）</summary>
      <p class="hint">出せるかどうかを決める話ではありません。輸出すると決めてから、輸入者や通関業者と進めます。</p><ul>${setup
      .map((i) => `<li><b>${explain(plainTitle(i.title))}</b>${i.rowId === "US-F2" ? "（切れると出荷が止まります）" : ""}：${explain(i.todo || i.question || i.reason)} <span class="rid">${esc(i.rowId)}</span></li>`)
      .join("")}</ul>
      <div class="handoff"><b>この続きは、Claude（AIの相談相手）に頼めます。</b>段取りの順番表、${c.name === "中国" ? "中国語" : "英語"}ラベルの案、輸入者へのメールの下書きを作れます。
        <div><button class="primary" id="handoff">Claudeに相談する</button> <span id="handoffMsg" class="hint">押すと相談文がコピーされ、Claudeが開きます。貼り付けて送ってください。</span></div>
        <details class="hpre"><summary>相談文を見る</summary><pre>${esc(handoffText(c))}</pre></details></div></details>`;
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
    html += `<details class="na naall"><summary>この商品には当てはまらない項目 ${naAll.length}件（開く）</summary>
      <p class="hint">決まりノートの行は全部当てはめています。ここは、この商品には関係しないと判定した行です。</p>${naAll.map(card).join("")}</details>`;
  }
  html += `<datalist id="ansChoices"><option value="社内に聞きます"><option value="仕入先に聞きます"><option value="測っていません"><option value="まだ決まっていません"></datalist>`;
  $("#countryBody").innerHTML = html;
  document.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("mouseenter", () => highlight(el.dataset.quote));
    el.addEventListener("mouseleave", () => highlight(""));
  });
  const ho = $("#handoff");
  if (ho) ho.addEventListener("click", async () => {
    const text = handoffText(c);
    try { await navigator.clipboard.writeText(text); $("#handoffMsg").textContent = "コピーしました。開いたClaudeに貼り付けて送ってください。"; }
    catch { $("#handoffMsg").textContent = "コピーできませんでした。"; }
    window.open("https://claude.ai/new", "_blank", "noopener");
  });
  const rerun = $("#rerun");
  document.querySelectorAll(".rerun2").forEach((b) => b.addEventListener("click", () => {
    b.closest(".usask").querySelectorAll("[data-q]").forEach((el) => {
      if (el.value.trim()) state.extraAnswers[el.dataset.q] = el.value.trim();
    });
    run(false, state.country);
  }));
  if (rerun) rerun.addEventListener("click", () => {
    // 同じ項目（pHなど）が上の帯と下の欄の両方にあるので、どちらかに入っていれば使う
    const vals = {};
    document.querySelectorAll("[data-q]").forEach((el) => {
      const v = el.value.trim();
      if (v) vals[el.dataset.q] = v;
      else if (!(el.dataset.q in vals)) vals[el.dataset.q] = "";
    });
    for (const [k, v] of Object.entries(vals)) { if (v) state.extraAnswers[k] = v; else delete state.extraAnswers[k]; }
    run(false, state.country);
  });
}

// 「出すと決めたら」の続きをClaudeに頼むための相談文（判定はしない。結果をまとめるだけ）
function handoffText(c) {
  const t = (x) => plainTitle(x.title);
  const v = c.verdict || { tier: "進められる見込み", items: [] };
  const by = (lv) => c.items.filter((i) => i.level === lv && !i.setup);
  const lines = [
    `国内で売っている加工食品を、${c.name}へ輸出する準備を手伝ってください。輸出は初めてです。`,
    "",
    "## 商品のラベル（日本語）",
    ...(state.label?.lines || []),
    "",
    `## 輸出チェックの見立て（判定日 ${state.result.asOf}）：${v.tier}`,
    ...v.items.map((x) => `- ${t(x)}${x.workaround ? `（回避策：${x.workaround.replace(/【[^】]*】/g, "")}）` : ""}`),
    "",
    "## 直す所",
    ...by("直せば出せる").map((i) => `- ${t(i)}：${i.todo || i.reason}`),
    ...by("出せない").map((i) => `- 【出荷できない条件】${t(i)}：${i.todo || i.reason}`),
    "",
    "## 輸出用ラベルで足す所",
    ...by("輸出用に足す").map((i) => `- ${t(i)}`),
    "",
    "## まだ決まっていないこと",
    ...c.items.filter((i) => i.status === "分からない" && i.question && !i.setup).map((i) => `- ${i.question}（${whoGroup(i.askWho, i.todoKind)}に聞く）`),
    "",
    "## 出すと決めた後の段取り",
    ...c.items.filter((i) => i.setup).map((i) => `- ${t(i)}：${i.todo || i.reason}`),
    "",
    "## お願い",
    "1. 上の段取りを、誰が・いつまでに・何をするかの順番表にしてください。",
    `2. ${c.name}向けのラベル表示案（${c.name === "中国" ? "中国語" : "英語"}）の下書きを作ってください。分からない所は空欄にして、聞いてください。`,
    "3. 輸入者に確かめるメールの下書きを作ってください。",
    "規制の話には、公的な出典を付けてください。この結果は判定ルールに基づく相談の準備用で、輸入許可や通関を保証するものではありません。",
  ];
  // 中身の無い見出しは外す
  const out = lines.filter((l, k) => !(l.startsWith("## ") && (lines[k + 1] ?? "") === ""));
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

const ORDER_LV = { 出せない: 0, 直せば出せる: 1, 確認が必要: 2, 輸出用に足す: 3 };
const isAfterStopItem = (i) => /止められた後|不合格になった後/.test(i.title || "");

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
  "US Agent": "米国内の代理人。FDAとの連絡窓口になる人や会社。輸入者や代行サービスに頼める",
  "FURLS": "FDAの登録をするウェブの窓口",
  "ISF": "船で米国に送るとき、積む前に出す輸入者の申告",
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
// 答えると他の行も決まりやすい順（議論の結論 11/4）：売り先・輸入の責任者 → 国ごとの順
const Q_ORDER = {
  ALL: [/売り先|販売先|輸入者|輸入の責任|どの国で売/],
  US: [/肉|卵|豚|鶏|牛/, /魚|水産|種名|魚種/, /pH|水分活性|冷蔵|常温|殺菌/],
  EU: [/肉|卵|乳|魚|水産|動物性/, /施設|認定|第三国/],
  CN: [/産地|都県|最後に加工|最終加工/, /登録|証明書|推薦/],
};
function qPriority(i, code) {
  const t = `${i.title} ${i.question}`;
  const lists = [...Q_ORDER.ALL, ...(Q_ORDER[code] || [])];
  const k = lists.findIndex((re) => re.test(t));
  return k === -1 ? 99 : k;
}
function qHtml(i, inputs, why, who) {
  return `<div class="q"><div>
    <div class="q-topic">${explain(plainTitle(i.title))} <small>${esc(i.rowId)}・${esc(who)}に聞く</small></div>
    <div class="q-ask">${explain(i.question)}</div>
    ${why ? `<div class="why"><b>なぜ聞くか：</b>${explain(why)}</div>` : ""}
  </div><div class="qin">${inputs}</div></div>`;
}

// 聞く相手ごとにまとめる（答えが返ってきた言葉から振り分ける）
const WHO_GROUPS = [
  ["工場の品質管理の担当", /工場|品質|製造|自社/],
  ["原料の仕入れ先", /仕入|原料メーカー|原料の/],
  ["相手の国の輸入者", /輸入者|輸入業者|バイヤー/],
  ["商社・倉庫", /商社|倉庫|物流|通関/],
];
function whoGroup(askWho, todoKind) {
  const t = askWho || "";
  for (const [name, re] of WHO_GROUPS) if (re.test(t)) return name;
  if (todoKind === "輸入者に聞く") return "相手の国の輸入者";
  return "そのほか";
}

function conceptMap() {
  return `<figure class="concept">
    <p class="concept-lead">ラベルを直せば出せる、とは限りません。この3つをセットで見ないと、見落とします。</p>
    <div class="cbox c-製品"><b>製品の要件</b><small>国によって決まりが違う。ラベルと原料を合わせる</small>
      <ul><li>アレルゲンの対象が国ごとに違う（米国はごま、EUはセロリ・からしも）</li><li>日本で使える添加物・着色料が、使えない国がある</li><li>栄養成分の表示の様式が国ごとに違う</li></ul></div>
    <div class="carrow">→</div>
    <div class="cbox c-交差"><b>この製品だから必要な要件</b><small>ラベルではなく、原料や作り方で工場・仕入先に求められること</small>
      <ul><li>常温のレトルトは、米国で殺菌工程の届け出が要ることがある</li><li>鰹節入りは、EUの認定施設の鰹節が要ることがある</li></ul></div>
    <div class="carrow">←</div>
    <div class="cbox c-施設"><b>施設の要件</b><small>作る・保管する場所の準備。要る国と要らない国がある</small>
      <ul><li>工場の登録が要る国がある（米国・中国など）</li><li>ラベルを貼るだけの倉庫も、登録が要ることがある</li><li>衛生管理の計画や、出荷ごとの届け出</li></ul></div>
    <figcaption>チャットのAIに聞くだけだと、書いてある物しか見ず、真ん中の決まりを見落としがちです。この道具は、決まりノートの行を<strong>1行も飛ばさず</strong>当てはめます。</figcaption>
  </figure>`;
}
$("#conceptHead").innerHTML = conceptMap();

function card(i) {
  const up = i.upcoming.map((d) => `<span class="tag up">${esc(d.label)} ${esc(d.date)}</span>`).join("");
  const weak = i.weakSource ? `<span class="tag weak" title="${esc(i.marks.join(" "))}">出典は二次資料です。出荷前に窓口で確かめてください</span>` : "";
  const prog = i.decidedBy === "program" ? `<span class="tag prog">判定ルールに基づく結果です</span>` : "";
  const flags = i.flags.length ? `<div class="flags">言い切れないので「確認が必要」にしました：${i.flags.map(esc).join("／")}</div>` : "";
  const quote = i.labelQuote ? `<div class="q-label">ラベル：「${esc(i.labelQuote)}」</div>` : i.absentOnLabel ? `<div class="q-label">ラベル：書いていない</div>` : "";
  const answer = i.answerKeys.length ? `<div class="q-label">答え：${i.answerKeys.map(esc).join("、")}</div>` : "";
  const nq = i.noteQuote ? `<div class="q-note">ノート：「${esc(i.noteQuote)}」</div>` : "";
  const link = i.urls[0] ? `<a href="${esc(i.urls[0])}" target="_blank" rel="noopener">出典</a>` : "";
  const way = i.workaround && ["出せない", "直せば出せる"].includes(i.level) ? `<div class="way"><b>回避策：</b>${explain(i.workaround)}</div>` : "";
  const hard = i.hard && ["出せない", "直せば出せる"].includes(i.level) ? `<span class="tag weak">現実的に厳しい</span>` : "";
  return `<article class="card ${LEVEL_CLASS[i.level]}" data-quote="${esc(i.labelQuote)}">
    <header><span class="badge ${LEVEL_CLASS[i.level]}">${esc(levelWord(i.level))}</span><b>${esc(i.rowId)}</b> ${explain(plainTitle(i.title))}</header>
    <p>${esc(i.reason)}</p>
    ${quote}${answer}${nq}${flags}
    ${i.todo ? `<div class="todo">次に：${esc(i.todo)}</div>` : ""}${way}
    <footer>判定：${esc(i.status)} ${hard}${prog}${weak}${up} ${link}</footer>
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

// ラベルに書き込んで見る：読み取ったラベルを描き直し、その行の横に指摘を付ける。
// ラベルに書いていない項目や工場の話は、製造者の行か、下の「ラベルに無い所」に付ける。
function renderAnnotated() {
  // 3か国を並べて書き込む（藤井さん 11/4）。調べた国が列になり、まだの国は「チェックする」ボタン
  const r = state.result;
  const lines = state.label.lines;
  const cs = ["US", "EU", "CN"].filter((c) => r.countries[c]);
  const rest = ["US", "EU", "CN"].filter((c) => !r.countries[c]);
  const keep = (i) => !i.setup && ["出せない", "直せば出せる", "確認が必要", "輸出用に足す"].includes(i.level);
  const makerLine = lines.findIndex((l) => /製造者|製造所|販売者|加工者/.test(l));
  // place[国][行] = 指摘の配列。最後の行（lines.length）は「ラベルに書いていない所」
  const place = {};
  for (const code of cs) {
    const at = lines.map(() => []).concat([[]]);
    for (const i of r.countries[code].items.filter(keep)) {
      const q = nrm(i.labelQuote);
      let k = q ? lines.findIndex((l) => nrm(l).includes(q)) : -1;
      if (k === -1 && (i.box === "施設" || i.box === "交差") && makerLine !== -1 && !i.absentOnLabel) k = makerLine;
      at[k === -1 ? lines.length : k].push(i);
    }
    place[code] = at;
  }
  const ORDER = { 出せない: 0, 直せば出せる: 1, 確認が必要: 2, 輸出用に足す: 3 };
  const call = (i) => `<details class="callout ${LEVEL_CLASS[i.level]}"><summary><span class="dot ${LEVEL_CLASS[i.level]}" title="${esc(levelWord(i.level))}"></span>${explain(plainTitle(i.title))}</summary>
    ${i.todo || i.question ? `<div class="why">${explain(i.todo || i.question)}</div>` : ""}${i.workaround ? `<div class="why"><b>回避策：</b>${shortWays(i.workaround).map((w) => explain(w.head)).join("／")}</div>` : ""}</details>`;
  const cell = (code, k) => {
    const its = place[code][k].slice().sort((x, y) => ORDER[x.level] - ORDER[y.level]);
    const top = its.slice(0, 3), rest = its.slice(3);
    const cnt = (lv) => rest.filter((i) => i.level === lv).length;
    const restWord = [["出せない", "出荷できない条件"], ["直せば出せる", "直す所"], ["確認が必要", "確かめること"], ["輸出用に足す", "輸出用ラベルで足す所"]]
      .filter(([lv]) => cnt(lv)).map(([lv, w]) => `${w}${cnt(lv)}件`).join("・");
    return `<div class="a3-cell" data-c="${code}"><span class="a3-cn">${esc(r.countries[code].name)}</span>${top.map(call).join("")}${rest.length ? `<details class="a3-more"><summary>ほかにも ${restWord}</summary>${rest.map(call).join("")}</details>` : ""}</div>`;
  };
  const row = (text, k, extra = "") => {
    const has = cs.some((c) => place[c][k].length);
    return `<div class="a3-row ${has ? "has" : ""} ${extra}"><div class="al-line">${esc(text)}</div>
      ${has ? cs.map((c) => cell(c, k)).join("") : `<div class="al-none" style="grid-column: span ${cs.length}">今回の確認では、追加の指摘はありません</div>`}</div>`;
  };
  const head = cs.map((code) => {
    const c = r.countries[code];
    const v = c.verdict || { tier: "進められる見込み" };
    const cls = { 入口で無理: "ol-stop", 現実的に厳しい: "ol-hard", 回避策がある: "ol-way", 進められる見込み: "ol-go" }[v.tier];
    const wall = (v.items || [])[0];
    return `<div class="a3-head outlook ${cls}"><div><b>${esc(c.name)}</b> <span class="tier">${esc(v.tier)}</span></div>${wall ? `<div class="a3-wall">いちばんの壁：${explain(plainTitle(wall.title))}</div>` : ""}</div>`;
  }).join("");
  const more = rest.length ? `<p class="a3-rest">ほかの国も並べる：${rest.map((c) => `<button class="ghost nextc2" data-c="${c}">${COUNTRY_NAMES[c]}でチェックする</button>`).join("")}</p>` : "";
  const photo = state.image ? `<details class="al-photo"><summary>元の写真と見比べる</summary><img src="data:${esc(state.mediaType)};base64,${state.image}" alt="ラベルの写真"></details>` : "";
  $("#countryBody").innerHTML = `<p class="hint">同じラベルの行の横に、国ごとの指摘を並べました。押すと中身が開きます。見立てだけで輸出先を決めず、売り先や費用とあわせて輸入者と相談してください。</p>${more}${photo}
    <div class="annot3" style="--n:${cs.length}">
      <div class="a3-row a3-top"><div></div>${head}</div>
      ${row("輸出前に確かめること（ラベルだけでは済まない：工場・原料・手続き）", lines.length, "al-missing al-band")}
      ${lines.map((l, k) => row(l, k)).join("")}
    </div>
    <p class="legend"><span class="dot lv-stop"></span>出荷できない条件 <span class="dot lv-fix"></span>直す所 <span class="dot lv-ask"></span>確かめること <span class="dot lv-add"></span>輸出用ラベルで足す所</p>`;
  document.querySelectorAll(".nextc2").forEach((b) => b.addEventListener("click", () => run(false, b.dataset.c)));
}

// 米国の缶詰・瓶詰・レトルトの区分（見せ場）。乾物以外は必ずどれかを出し、数値が無ければその場で聞く
const US_CLASS_NEEDS = {
  低酸性缶詰食品: ["工場の登録（FCE）", "製品ごとの殺菌条件の届け出（SID）。条件は殺菌の専門家が決める", "工場に、FDAの講習（Better Process Control School）を受けた責任者を置く"],
  酸性化食品: ["工場の登録（FCE）", "製品ごとの工程の届け出（SID）。pHの管理と記録", "工場に、FDAの講習（Better Process Control School）を受けた責任者を置く"],
};
function usClassBand(c) {
  const u = c.usClass;
  if (!u) return "";
  const lacf = u.cls === "低酸性缶詰食品", af = u.cls === "酸性化食品";
  const tone = lacf || af ? "ol-way" : u.cls === "分からない" ? "ol-hard" : "ol-go";
  const head = lacf || af ? `米国では「${u.cls}」に${u.sure ? "当たります" : "当たる見込みです"}` : u.cls === "分からない" ? "米国の缶詰・レトルトの区分は、まだ決まっていません" : `米国の缶詰・レトルトの区分：${u.cls}${u.sure ? "" : "（見込み）"}`;
  const needs = (US_CLASS_NEEDS[u.cls] || []);
  const row = c.items.find((i) => i.rowId === (af ? "US-X2" : "US-X1"));
  const ways = lacf || af ? shortWays(row?.workaround) : [];
  const ask = !u.sure && u.cls !== "冷蔵・冷凍";
  const inp = (key, label, ph) => `<label class="qf"><span>${label}</span><input data-q="${key}" placeholder="${ph}" value="${esc(state.extraAnswers[key] || "")}"></label>`;
  return `<div class="outlook usclass ${tone}"><span class="tier">米国：缶詰・瓶詰・レトルトの区分</span><p class="ol-main">${esc(head)}</p><p>${explain(u.why)}</p>
    ${needs.length ? `<div class="way"><b>当たると要るもの</b><ul>${needs.map((n) => `<li>${explain(n)}</li>`).join("")}</ul></div>` : ""}
    ${ways.length ? `<div class="way"><b>回避策</b><ul>${ways.map((w) => `<li>${explain(w.head)}${w.remain ? `<div class="remain">残ること：${explain(w.remain)}</div>` : ""}</li>`).join("")}</ul></div>` : ""}
    ${ask ? `<div class="usask"><b>品質管理の担当に聞いて、入れてください</b>（「この商品の完成品の pH と水分活性を教えてください」）
      <div class="qin">${inp("pH", "pH", "例：5.8")}${inp("Aw", "水分活性", "例：0.97")}<label class="qf"><span>工場から店までの温度</span><select data-q="保存"><option value=""></option>${["ずっと冷蔵", "途中で常温に置く時間がある", "常温"].map((o) => `<option ${state.extraAnswers["保存"] === o ? "selected" : ""}>${o}</option>`).join("")}</select></label></div>
      <button class="primary rerun2">入れて、もう一度チェック</button></div>` : ""}
  </div>`;
}

// 一番上の「見立てと次の一歩」（議論の結論 11/4：主役は輸出の可能性と次の一歩。確率は出さない）
// 回避策の短い形：①②③ごとに「一言」と【残る：〜】。かっこの中（くわしい説明）は開いたら見える
function shortWays(w) {
  const parts = String(w || "").split(/(?=[①②③④⑤])/).map((x) => x.trim()).filter(Boolean);
  return parts
    .filter((x) => !/^相談先/.test(x))
    .map((x) => {
      const remain = (x.match(/【残る[：:]([^】]+)】/) || [])[1] || "";
      const head = x.replace(/【[^】]*】/g, "").replace(/[（(].*$/s, "").replace(/。.*$/s, "").trim();
      return { head, remain };
    })
    .filter((x) => x.head)
    .slice(0, 3);
}
function outlook(c) {
  const name = esc(c.name);
  const v = c.verdict || { tier: "進められる見込み", items: [] };
  const qs = c.items.filter((i) => i.status === "分からない" && i.question && !i.setup).sort((x, y) => qPriority(x, state.country) - qPriority(y, state.country));
  const q0 = qs[0];
  // ラベル以外（工場・手続き）で残っている直す所。「ラベルを貼れば出せる」と思わせないため、見立てが良くても必ず出す
  const beyondAll = c.items.filter((i) => i.level === "直せば出せる" && !i.setup && ["施設", "交差"].includes(i.box));
  const beyond = beyondAll.slice(0, 3);
  const beyondMore = beyondAll.length > 3 ? ` ほか${beyondAll.length - 3}件` : "";
  const MSG = {
    入口で無理: ["ol-stop", `${name}へは、今の仕様では輸出できません。`, "国として受け入れを止めている条件です。この道具では回避策を見つけられていません。"],
    現実的に厳しい: ["ol-hard", `${name}へは、大きな課題があります。`, "制度の上では道がありますが、この道具では現実的な回避策を見つけられていません。"],
    回避策がある: ["ol-way", `${name}へは、このままでは出せません。でも回避策があります。`, ""],
    進められる見込み: ["ol-go", `${name}へは、進めそうです。`, ""],
  }[v.tier];
  const li = (x) => {
    const ways = v.tier === "回避策がある" ? shortWays(x.workaround) : [];
    return `<li><b>${explain(plainTitle(x.title))}</b>
      ${ways.length ? `<div class="way"><b>回避策</b><ul>${ways.map((w) => `<li>${explain(w.head)}${w.remain ? `<div class="remain">残ること：${explain(w.remain)}</div>` : ""}</li>`).join("")}</ul></div>` : ""}
      <details class="more"><summary>くわしく</summary>${x.reason ? `<p>${explain(x.reason)}</p>` : ""}${x.workaround ? `<p>${explain(x.workaround)}</p>` : ""}</details></li>`;
  };
  return usClassBand(c) + `<div class="outlook ${MSG[0]}"><span class="tier">${esc(v.tier)}</span>
    <p class="ol-main">${MSG[1]}</p>${MSG[2] ? `<p>${MSG[2]}</p>` : ""}
    ${v.items.length ? `<ul class="ol-list">${v.items.map(li).join("")}</ul>` : ""}
    ${v.tier === "進められる見込み" && beyond.length ? `<p class="beyond"><b>ただし、ラベル以外にも残っています：</b>${beyond.map((i) => explain(plainTitle(i.title))).join("、")}${beyondMore}</p>` : ""}
    ${q0 ? `<p><b>まず確かめること：</b>${explain(q0.question)}（${esc(whoGroup(q0.askWho, q0.todoKind))}へ）</p>` : ""}
    <p class="hint">相談の準備用です。出荷の前に、輸入者と確かめてください。</p></div>`;
}
