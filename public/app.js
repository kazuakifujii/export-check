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
  $("#countryTabs").innerHTML += `<button class="ghost opbtn" id="opOpen">社長に出す1枚</button>`;
  $("#opOpen").addEventListener("click", openOnePager);
  document.querySelectorAll(".nextc").forEach((b) => b.addEventListener("click", () => run(false, b.dataset.c)));
  renderCountry(r.countries[state.country]);
}

function renderCountry(c) {
  const s = c.summary;
  const f = state.filter;
  const chip = (lv, word) =>
    `<button class="chip ${LEVEL_CLASS[lv]} ${f === lv ? "on" : ""} ${f && f !== lv ? "dim" : ""}" data-lv="${lv}" title="押すと、これだけを表示します" ${s[lv] ? "" : "disabled"}>${word} ${s[lv]}</button>`;
  let html = `<div class="summary">
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
      ${shown.map(card).join("") || `<p class="hint">ここで引っかかる所は見つかっていません</p>`}
      ${add.length ? `<details class="addon"><summary>＋α 輸出用ラベルで足す所（${add.length}）</summary>
        <p class="hint">日本のラベルに無いのは当たり前のものです。輸出用のラベルを作るときに入れてください。</p>${add.map(card).join("")}</details>` : ""}
    </section>`;
  }
  html += `</div>`;

  const qs = c.items.filter((i) => i.status === "分からない" && i.question).sort((x, y) => qPriority(x, state.country) - qPriority(y, state.country));
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
    html += `<section class="questions"><h3>次に確かめること</h3>
      <p class="progress">まずこの${firstThree.length}件です${rest > 0 ? `（残り${rest}件）` : ""}。答えると、ほかの行も一緒に決まりやすい順に並べています。</p>
      <p class="hint">一人で全部答えなくて大丈夫です。分かる人に聞いて、分かった所から入れてください。「社内に聞きます」「まだ決まっていません」のように答えても進めます。点線の下線の言葉は、マウスを乗せると意味が出ます。</p>
      ${firstHtml}
      ${rest > 0 ? `<p class="hint" style="margin-top:12px">残りは、聞く相手ごとにまとめています。</p>` : ""}
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
    html += `<details class="na naall"><summary>この商品には当てはまらない項目 ${naAll.length}件（開く）</summary>
      <p class="hint">決まりノートの行は全部当てはめています。ここは、この商品には関係しないと判定した行です。</p>${naAll.map(card).join("")}</details>`;
  }
  html += `<datalist id="ansChoices"><option value="社内に聞きます"><option value="仕入先に聞きます"><option value="測っていません"><option value="まだ決まっていません"></datalist>`;
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
    <div class="cbox c-製品"><b>製品の要件</b><small>ラベルと原料を、相手の国に合わせる</small>
      <ul><li>アレルゲンの表示</li><li>使える添加物・着色料</li><li>栄養成分の表示</li></ul></div>
    <div class="carrow">→</div>
    <div class="cbox c-交差"><b>交差するところ</b><small>商品だけ、工場だけでは分からない条件を、先に見つけます</small>
      <ul><li>常温のレトルトは、米国で殺菌工程の届け出が要ることがある</li><li>鰹節入りは、EUの認定施設の鰹節が要ることがある</li></ul></div>
    <div class="carrow">←</div>
    <div class="cbox c-施設"><b>施設の要件</b><small>作る・包む・保管する場所の準備</small>
      <ul><li>工場の登録</li><li>ラベルを貼るだけの倉庫も、登録が要ることがある</li></ul></div>
    <figcaption>チャットのAIにラベルを見せて聞くと、書いてある物だけを確かめ、欄ごと無い項目や真ん中の決まりを見落としがちです。だからこの道具は、決まりノートの行を<strong>1行も飛ばさず</strong>全部当てはめます（ノートに無い決まりは見られません）。</figcaption>
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

// 社長に出す1枚：調べた国を横に並べ、結果をまとめるだけ（新しい判定はしない）
function openOnePager() {
  const r = state.result;
  const cs = Object.keys(r.countries);
  const list = (items, f) => items.length ? `<ul>${items.slice(0, 6).map(f).join("")}${items.length > 6 ? `<li class="hint">ほか ${items.length - 6}件</li>` : ""}</ul>` : `<p class="hint">なし</p>`;
  const col = (code) => {
    const c = r.countries[code];
    const by = (lv) => c.items.filter((i) => i.level === lv);
    const ask = c.items.filter((i) => i.status === "分からない" && i.question).sort((x, y) => qPriority(x, code) - qPriority(y, code));
    const docs = c.tomorrow["日本で取る書類"] || [];
    return `<section class="op-col"><h3>${esc(c.name)}</h3>
      <p class="op-count"><span class="g-stop">出荷できない条件 ${c.summary["出せない"]}</span>／<span class="g-fix">直す所 ${c.summary["直せば出せる"]}</span>／<span class="g-ask">確かめること ${c.summary["確認が必要"]}</span></p>
      <h4>出荷できない条件</h4>${list(by("出せない"), (i) => `<li>${esc(plainTitle(i.title))}<br><small>${esc(i.todo || i.reason)}</small></li>`)}
      <h4>直す所（表示・登録・証明書）</h4>${list(by("直せば出せる"), (i) => `<li>${esc(plainTitle(i.title))}${i.todo ? `<br><small>${esc(i.todo)}</small>` : ""}</li>`)}
      <h4>日本で取る書類・登録</h4>${list(docs, (t) => `<li>${esc(t.text)}</li>`)}
      <h4>まだ決まっていないこと（誰に聞くか）</h4>${list(ask, (i) => `<li>${esc(i.question)}<br><small>${esc(whoGroup(i.askWho, i.todoKind))}に聞く</small></li>`)}
      <p class="hint">輸出用ラベルで足す所 ${c.summary["輸出用に足す"]}件は、ラベルを作るときにまとめて入れます。</p>
    </section>`;
  };
  const concern = state.lastConcern ? `<p><b>気になっていること：</b>${esc(state.lastConcern)}</p>` : "";
  $("#opBody").innerHTML = `<header class="op-head"><h2>輸出の検討メモ：${esc((state.label?.fields || []).find((f) => /名称|品名/.test(f.name))?.value || "この商品")}</h2>
      <p>判定日 ${esc(r.asOf)}／調べた国：${cs.map((c) => esc(r.countries[c].name)).join("・")}</p>
      <p><b>今回お願いしたいこと：</b>下の「まだ決まっていないこと」を担当に確かめ、「直す所」の見積もりを取ること。そのうえで、どの国から相談を始めるかを決めます。</p>${concern}</header>
    <div class="op-grid" style="grid-template-columns: repeat(${cs.length}, 1fr)">${cs.map(col).join("")}</div>
    <p class="hint">${cs.length < 3 ? "ほかの国も調べると、ここに並びます。" : ""}この1枚は相談の準備用です。輸入許可や通関を保証するものではありません。費用や日数は、輸入者や専門家の見積もりで確かめてください。</p>`;
  $("#onePager").hidden = false;
}
$("#opClose").addEventListener("click", () => ($("#onePager").hidden = true));
$("#opPrint").addEventListener("click", () => window.print());
