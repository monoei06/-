"use strict";

/* ===========================================================================
 * 中央競馬(JRA) AI予想アプリ
 * netkeiba の公開オッズ・出走表を、データサーバー(Cloudflare Worker)経由で取得し、
 * 「市場オッズから過剰率(控除)を除いた厳密な勝率」を基準に、Plackett–Luce の閉形式で
 * 単勝/複勝/馬連/ワイド/馬単/3連複/3連単の的中確率と期待値を計算する静的アプリ。
 * バックエンドは小さなプロキシ(worker/keiba-proxy.js)のみ。
 * =========================================================================== */

const APP_VERSION = "2026-06-13 競馬AI予想 v14（3連複の的中率改善・複勝基準＋広め＋8頭BOX）";

// データサーバー(Cloudflare Worker)の既定URL。未デプロイなら ⚙️ で各自設定。
const DEFAULT_PROXY_URL = "https://keiba.komemonoei.workers.dev/";
const PROXY_KEY = "keiba_proxy_url";

// 予想スタンス → 確率の鋭さ指数 BETA（市場勝率 p を p^BETA に補正して正規化）。
// バックテスト（81R）では市場どおり(=1.0)が最も的中率が高く、過去指数の上乗せは精度を
// 下げたため、既定は 1.0（市場どおり）。スタンスで本命寄り/穴寄りを選べる。
//  標準 std=1.00（市場どおり・最も的中重視）
//  堅実 kata=1.10（本命をより厚く＝さらに堅実）
//  穴   ana=0.90（本命依存を弱め広く＝妙味重視・的中率は下がる）
function stanceBeta() {
  return ({ std: 1.00, kata: 1.10, ana: 0.90 })[(stanceSel && stanceSel.value) || "std"] || 1.00;
}

const $ = (id) => document.getElementById(id);
const dateSel = $("datePick");
const stanceSel = $("stance");
const venueSel = $("venue");
const raceSel = $("race");
const predictBtn = $("predict");
const statusEl = $("status");
const resultEl = $("result");

let MEETINGS = [];           // [{place, place_code, meeting, races:[...]}]
let RACE_CACHE = new Map();  // race_id -> detail

/* ----------------------------- Claude（本格予想・AI視点） ------------------------------ */
const CLAUDE_KEY_LS = "keiba_anthropic_key";
const CLAUDE_MODEL = "claude-opus-4-8";
const CLAUDE_SYSTEM =
  "あなたは日本の中央競馬(JRA)に精通した、冷静で正直な予想アナリストです。与えられたオッズ・確率・近走データのみを根拠に、" +
  "『3連複の具体的な買い目』を必ず馬番と点数で提示します（軸◯番／相手◯,◯…／本線と抑えの2案）。データに無い事実は創作しないこと。" +
  "競馬は分散が大きく市場(オッズ)が最良の予測であることを理解し、必勝や過度な自信を示さないこと。" +
  "出力は見出し付きの短い箇条書き中心、全体800字以内、日本語で。";
let claudeKeyMem = "";
function getClaudeKey() {
  try { return (localStorage.getItem(CLAUDE_KEY_LS) || claudeKeyMem || "").trim(); }
  catch { return claudeKeyMem.trim(); }
}
function setClaudeKey(v) {
  claudeKeyMem = (v || "").trim();
  try { localStorage.setItem(CLAUDE_KEY_LS, claudeKeyMem); } catch { /* file:// */ }
}
let lastRender = null; // { race, A } 直近の予想（Claude呼び出し用）

async function callClaude(prompt) {
  const key = getClaudeKey();
  if (!key) throw new Error("Anthropic APIキーが未設定です（⚙️で設定）");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1800,
      system: CLAUDE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* noop */ }
    throw new Error("HTTP " + res.status + (detail ? " " + detail : ""));
  }
  const j = await res.json();
  if (j.stop_reason === "refusal") return "（安全上の理由で回答が見送られました）";
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// 3連複の買い目を構造化出力(JSON)で受け取るスキーマ
const CLAUDE_BET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    honmei: {
      type: "object", additionalProperties: false,
      properties: {
        axis: { type: "array", items: { type: "integer" } },
        partners: { type: "array", items: { type: "integer" } },
      },
      required: ["axis", "partners"],
    },
    osae: {
      type: "object", additionalProperties: false,
      properties: {
        axis: { type: "array", items: { type: "integer" } },
        partners: { type: "array", items: { type: "integer" } },
      },
      required: ["axis", "partners"],
    },
    comment: { type: "string" },
  },
  required: ["honmei", "osae", "comment"],
};

// Claude APIを構造化出力で呼び、JSON文字列を返す
async function callClaudeJSON(prompt, schema) {
  const key = getClaudeKey();
  if (!key) throw new Error("Anthropic APIキーが未設定です（⚙️で設定）");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: CLAUDE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema } },
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* noop */ }
    throw new Error("HTTP " + res.status + (detail ? " " + detail : ""));
  }
  const j = await res.json();
  if (j.stop_reason === "refusal") throw new Error("安全上の理由で回答が見送られました");
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// 予想結果(A)からClaudeへのプロンプトを組み立てる
function buildClaudePrompt(race, A) {
  const R = A.items;
  const lines = R.map((x, i) => {
    const h = x.h, ps = pastSummary(h.past);
    return (MARKS[i] || "・") + " " + x.idxNum + "番 " + (h.name || "") +
      "（" + (h.sexage || "") + (h.jockey ? " " + h.jockey : "") + "）" +
      " 単勝" + (h.win_odds != null ? h.win_odds + "倍" : "-") + "/" + (h.popularity || "-") + "人気" +
      " AI勝率" + x.p1.toFixed(1) + "% 複勝率" + x.in3.toFixed(0) + "%" +
      (h.weight_diff != null ? " 馬体重" + (h.weight_diff > 0 ? "+" : "") + h.weight_diff : "") +
      (ps && ps.best != null ? " 近走指数best" + ps.best + (ps.trend >= 5 ? "↑" : ps.trend <= -5 ? "↓" : "") : "");
  }).join("\n");
  const plans = buildTrioPlans(A).sort((a, b) => b.hit - a.hit).slice(0, 5)
    .map((p) => "・" + p.label + "：的中率" + p.hit.toFixed(0) + "% " + p.pts + "点").join("\n");
  const depth = A.depth;
  return "以下は " + race.place + race.race_no + "R「" + (race.name || "") + "」" +
    (race.course || "") + (race.direction ? "(" + race.direction + ")" : "") +
    (race.track_condition ? " 馬場" + race.track_condition : "") +
    (race.weather ? " 天候" + race.weather : "") + " の出走馬と、市場オッズに基づく確率です。\n\n" +
    "【出走馬（AI勝率＝市場オッズ由来の順）】\n" + lines + "\n" +
    "（複勝率は" + depth + "着内率。近走指数は基準タイム比の参考値・馬場/クラス未補正）\n\n" +
    "【3連複プラン候補（モデル算出の的中率）】\n" + plans + "\n\n" +
    "この情報をもとに、『3連複の買い目』を2案、馬番で選んでください（出力はJSON）。最優先は的中率（当てること）。\n" +
    "・3連複は3着以内に来るかが本質。馬の選定は勝率より『複勝率（3着内率）』を重視すること。\n" +
    "・honmei＝本線：的中率重視で気持ち広めに。軸(axis)1〜2頭＋相手(partners)で合計12〜18点程度を許容。\n" +
    "・osae＝抑え：さらに手広いBOX等で取りこぼしを防ぐ（合計〜35点程度。上位6〜8頭BOXでも可）。\n" +
    "・axis/partners は馬番(整数)の配列。BOXで買う場合は axis を空配列[]にし、partners に対象馬を全部入れる。\n" +
    "・複勝率が高い人気薄は積極的に相手へ。ただし明らかな実力下位（複勝率が極端に低い馬）は外す。\n" +
    "・comment＝軸・相手の理由、当てるための狙い、リスクを2〜4行で簡潔に（日本語）。\n" +
    "市場(オッズ)が最良予測である点を踏まえつつ、まずは的中率を上げる構成にすること。必勝ではない。";
}

// 本物のClaude予想をレース別にブラウザ保存（無料・claude.aiの回答を取り込む）
function claudeSavedKey(raceId) { return "keiba_claude_" + raceId; }
function getClaudeSaved(raceId) { try { return localStorage.getItem(claudeSavedKey(raceId)) || ""; } catch { return ""; } }
function setClaudeSaved(raceId, txt) { try { localStorage.setItem(claudeSavedKey(raceId), txt); } catch { /* file:// */ } }
let claudeEditing = false;
function curRaceId() { return lastRender && lastRender.race ? lastRender.race.race_id : ""; }

// Claudeセクションの中身（保存済みの本物Claude予想があれば表示、無ければ取込みUI）
// 「🧠 Claudeの予想」セクションの中身。APIキーがあれば本物のClaude(自動)を表示。
function claudeMainBody() {
  const rid = curRaceId();
  const saved = rid ? getClaudeSaved(rid) : "";
  if (saved && !claudeEditing) return realClaudeView(saved);
  if (getClaudeKey() && !claudeEditing) return '<div class="spinner"></div>Claudeが予想中…（10〜40秒）';
  // APIキー無し or 編集中 → アプリ内の総合分析＋（任意で）claude.ai手動取込み
  let h = "";
  if (lastRender) h += aiAnalysisHTML(lastRender.race, lastRender.A);
  h += '<details class="claude-manual"><summary>🟣 claude.ai（Maxプラン）の予想を手動で取り込む（無料）</summary>' +
    '<div class="claude-steps">⚙️で Anthropic APIキーを入れると、ここに本物のClaude予想が自動表示されます（推奨）。</div>' +
    claudeManualUI() + "</details>";
  return h;
}
function realClaudeView(saved) {
  // API(JSON)で保存された買い目ならカード表示、そうでなければ（手動取込み等）テキスト表示
  let obj = null;
  try { const o = JSON.parse(saved); if (o && (o.honmei || o.osae)) obj = o; } catch { obj = null; }
  if (obj && lastRender) return renderClaudeBets(obj, lastRender.A);
  return '<div class="claude-real">🟣 <b>Claudeの予想</b></div>' +
    '<div class="claude-text">' + esc(saved).replace(/\n/g, "<br>") + "</div>" +
    '<div class="claude-foot">' +
    '<button id="askClaude" class="claude-btn small">🔄 再予想</button>' +
    '<button id="editClaude" class="claude-btn small ghost">✏️ 手動で編集</button>' +
    "</div>";
}

// Claudeが選んだ買い目（軸/相手）→ アプリの的中率・点数・期待値つきカードに描画
function claudeTriosFor(axis, partners) {
  const pool = [], seen = {};
  for (const n of axis.concat(partners)) { if (!seen[n]) { seen[n] = 1; pool.push(n); } }
  const need = axis.slice();
  const res = [];
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
    const t = [pool[i], pool[j], pool[k]];
    let ok = true;
    for (const a of need) if (t.indexOf(a) < 0) { ok = false; break; }
    if (ok) res.push(t);
  }
  return res;
}
function claudePlanCard(label, axis, partners, A) {
  const trios = claudeTriosFor(axis, partners);
  if (!trios.length) return "";
  let hit = 0; const evc = [];
  for (const t of trios) {
    const pr = A.trio[trioKey(t[0], t[1], t[2])] || 0;
    hit += pr;
    evc.push({ prob: pr, odds: poolOdds(A.pools && A.pools.trio, tKey(t[0], t[1], t[2])) });
  }
  const ev = evRatio(evc);
  const chip = (n) => {
    const it = A.items.find((x) => x.idxNum === n);
    const rk = it ? A.items.indexOf(it) : -1;
    return chipHTML({ num: n, mark: rk >= 0 ? (MARKS[rk] || "") : "", name: it ? it.h.name : "" });
  };
  let h = '<div class="bet-box bet-fuku3"><div class="bet-type">' + esc(label) +
    '<span class="bet-hit">的中率 <b>' + (hit * 100).toFixed(1) + "%</b></span></div>";
  h += '<div class="fm">';
  if (axis.length) h += '<div class="fm-row"><span class="fm-pos">軸</span><span class="fm-chips">' + axis.map(chip).join("") + "</span></div>";
  h += '<div class="fm-row"><span class="fm-pos">' + (axis.length ? "相手" : "BOX") + '</span><span class="fm-chips">' + partners.map(chip).join("") + "</span></div>";
  h += "</div>";
  h += '<div class="bet-summary">' + trios.length + "点 = <b>" + (trios.length * 100).toLocaleString() + "円</b>（100円/点）";
  if (ev != null && isFinite(ev)) {
    const roi = (ev - 1) * 100;
    h += ' ／ 期待値 <b class="' + (ev >= 1 ? "ev" : "") + '">' + ev.toFixed(2) + "</b>" +
      '<span class="roi ' + (roi >= 0 ? "pos" : "neg") + '">ROI ' + (roi >= 0 ? "+" : "") + roi.toFixed(0) + "%</span>";
  }
  h += "</div></div>";
  return h;
}
function renderClaudeBets(obj, A) {
  const valid = {};
  A.items.forEach((x) => { valid[x.idxNum] = 1; });
  const clean = (arr) => (Array.isArray(arr) ? arr.map(Number).filter((n) => valid[n]) : []);
  let h = '<div class="claude-real">🟣 <b>Claudeの勝てる馬券（3連複）</b>（claude-opus-4-8）</div>';
  h += '<div class="bets">';
  if (obj.honmei) h += claudePlanCard("本線（堅め）", clean(obj.honmei.axis), clean(obj.honmei.partners), A);
  if (obj.osae) h += claudePlanCard("抑え（手広め/穴）", clean(obj.osae.axis), clean(obj.osae.partners), A);
  h += "</div>";
  if (obj.comment) h += '<div class="claude-text">💬 ' + esc(obj.comment).replace(/\n/g, "<br>") + "</div>";
  h += '<div class="claude-foot"><button id="askClaude" class="claude-btn small">🔄 再予想</button></div>';
  return h;
}
// 手動取り込みUI（コピー → claude.ai → 貼り付け → 保存）
function claudeManualUI() {
  return '<div class="claude-steps">① <button id="copyClaude" class="claude-btn small">📋 プロンプトをコピー</button>' +
    ' ② <a class="claude-link" href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai に貼り付け ↗</a>' +
    " ③ 返答を下に貼って保存</div>" +
    '<span id="claudeCopyMsg" class="claude-copied"></span>' +
    '<div id="claudePromptBox"></div>' +
    '<textarea id="claudePaste" class="claude-ta" rows="5" placeholder="claude.ai（Maxプラン）から返ってきたClaudeの予想をここに貼り付け"></textarea>' +
    '<div class="claude-foot"><button id="saveClaude" class="claude-btn">この内容を表示・保存</button></div>';
}
function refreshClaudeOut() { const el = $("claudeOut"); if (el) el.innerHTML = claudeMainBody(); }

// プロンプトをクリップボードへ（UIは保持。失敗時は手動コピー用に表示）
async function copyClaudePrompt() {
  if (!lastRender) return;
  const p = buildClaudePrompt(lastRender.race, lastRender.A);
  let ok = false;
  try { await navigator.clipboard.writeText(p); ok = true; } catch { ok = false; }
  const msg = $("claudeCopyMsg");
  if (msg) msg.textContent = ok ? "✅ コピーしました。claude.ai に貼り付けてください。" : "自動コピー不可。下のプロンプトを手動でコピーしてください。";
  if (!ok) {
    const box = $("claudePromptBox");
    if (box) {
      box.innerHTML = '<textarea class="claude-ta" readonly rows="5">' + esc(p) + "</textarea>";
      const ta = box.querySelector("textarea"); if (ta) { ta.focus(); ta.select(); }
    }
  }
}

// 貼り付けられたClaudeの回答を保存して表示
function saveClaudeReply() {
  const ta = $("claudePaste");
  if (!ta) return;
  const txt = (ta.value || "").trim();
  const msg = $("claudeCopyMsg");
  if (!txt) { if (msg) msg.textContent = "貼り付け内容が空です。"; return; }
  const rid = curRaceId();
  if (rid) setClaudeSaved(rid, txt);
  claudeEditing = false;
  refreshClaudeOut();
}
function editClaudeReply() { claudeEditing = true; refreshClaudeOut(); }

// （任意・有料）APIで本物のClaudeを自動取得し、回答として保存
async function runClaude() {
  const out = $("claudeOut");
  if (!out || !lastRender) return;
  out.innerHTML = '<div class="spinner"></div>Claudeが勝てる馬券を予想中…（10〜40秒）';
  try {
    const txt = await callClaudeJSON(buildClaudePrompt(lastRender.race, lastRender.A), CLAUDE_BET_SCHEMA);
    const rid = curRaceId();
    if (rid) setClaudeSaved(rid, txt);
    claudeEditing = false;
    refreshClaudeOut();
  } catch (e) {
    out.innerHTML = '<div class="status error">Claude(API)の取得に失敗：' + esc((e && e.message) || e) + "</div>" +
      '<button id="askClaude" class="claude-btn small">🔄 再試行</button>' +
      (lastRender ? '<div class="ai-fallback">' + aiAnalysisHTML(lastRender.race, lastRender.A) + "</div>" : "");
  }
}

/* ----------------------------- データサーバー設定 ------------------------------ */
let proxyUrlMem = "";
function hashProxyUrl() {
  try {
    const v = new URLSearchParams((location.hash || "").replace(/^#/, "")).get("proxy");
    return v ? decodeURIComponent(v) : "";
  } catch { return ""; }
}
function getProxyUrl() {
  let saved = "";
  try { saved = localStorage.getItem(PROXY_KEY) || ""; } catch { saved = proxyUrlMem; }
  return (saved || proxyUrlMem || hashProxyUrl() || DEFAULT_PROXY_URL || "").trim();
}
function setProxyUrl(v) {
  proxyUrlMem = (v || "").trim();
  try { localStorage.setItem(PROXY_KEY, proxyUrlMem); } catch { /* file:// 等 */ }
}
function proxyGet(params) {
  const base = getProxyUrl();
  if (!base) throw new Error("データサーバー未設定（⚙️から設定してください）");
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + params + "&_=" + Date.now();
}

/* ----------------------------- データ取得 ------------------------------ */
async function loadData() {
  if (!getProxyUrl()) {
    setStatus("⚙️ まず<b>データサーバー</b>を設定してください（<code>worker/KEIBA-README.md</code>）。" +
      "Cloudflare Workers に <code>keiba-proxy.js</code> を1度だけデプロイし、URL を⚙️に貼り付けます。", true);
    return;
  }
  const date = selectedDate();
  setStatus('<div class="spinner"></div>' + fmtDate(date) + ' の開催・レースを取得中…');
  try {
    const res = await fetch(proxyGet("date=" + date), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    MEETINGS = Array.isArray(j.meetings) ? j.meetings : [];
    if (!MEETINGS.length) {
      setStatus(fmtDate(j.date) + " は中央競馬の開催が見つかりませんでした。日付を変えてお試しください。", true);
      return;
    }
    RACE_CACHE = new Map();
    populateVenues();
    setStatus("✅ " + fmtDate(j.date) + "・" + MEETINGS.length + "開催／" + j.race_count +
      "レースを取得。開催とレースを選んで「予想する」！");
  } catch (e) {
    setStatus("データ取得に失敗しました。データサーバーURL（⚙️）と通信環境を確認してください。<br><small>" +
      esc((e && e.message) || e) + "</small>", true);
  }
}

/* ----------------------------- セレクト構築 ------------------------------ */
function populateVenues() {
  venueSel.innerHTML = "";
  MEETINGS.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = (m.meeting || m.place) + "（" + m.races.length + "R）";
    venueSel.appendChild(opt);
  });
  venueSel.disabled = false;
  populateRaces();
}
function populateRaces() {
  const m = MEETINGS[Number(venueSel.value)];
  raceSel.innerHTML = "";
  if (!m) return;
  for (const r of m.races) {
    const opt = document.createElement("option");
    opt.value = r.race_id;
    opt.textContent = r.race_no + "R " + (r.post_time ? r.post_time + " " : "") +
      (r.name || "") + (r.course ? " " + r.course : "");
    raceSel.appendChild(opt);
  }
  raceSel.disabled = false;
  predictBtn.disabled = false;
}

/* ----------------------------- 予想ロジック ------------------------------ */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
const seq = (n) => Array.from({ length: n }, (_, i) => i);

// 出走馬から「市場の勝率」を算出。
// オッズの逆数を正規化（=控除率/過剰率を除去）したものが市場の主観勝率。
function marketProbs(horses) {
  const active = horses.filter((h) => h.win_odds && h.win_odds > 0);
  let basis = "odds";
  let inv;
  if (active.length >= 2) {
    inv = active.map((h) => 1 / h.win_odds);
  } else {
    // オッズ未発表 → 人気順があれば人気を、無ければ均等
    const byPop = horses.filter((h) => h.popularity);
    if (byPop.length >= 2) { basis = "pop"; return popFallback(horses); }
    basis = "equal";
    const all = horses.slice();
    const p = 1 / all.length;
    return { items: all.map((h) => ({ h, p })), basis };
  }
  const s = inv.reduce((a, b) => a + b, 0);
  return { items: active.map((h, i) => ({ h, p: inv[i] / s })), basis, overround: s };
}
function popFallback(horses) {
  // 人気iの概算勝率（経験的）。1番人気≈33%,2≈19%… を正規化。
  const base = [33, 19, 13, 9, 7, 5, 4, 3, 2.2, 1.8, 1.4, 1.1, 0.9, 0.7, 0.6, 0.5, 0.4, 0.3];
  const items = horses.filter((h) => h.popularity).map((h) => ({ h, raw: base[h.popularity - 1] || 0.3 }));
  const s = items.reduce((a, x) => a + x.raw, 0);
  return { items: items.map((x) => ({ h: x.h, p: x.raw / s })), basis: "pop" };
}

// 厳密確率計算（乱数なし）。Plackett–Luce 閉形式。
function analyze(horses, pools) {
  const mk = marketProbs(horses);
  const n = mk.items.length;
  const beta = stanceBeta();
  const items = mk.items.map((x) => ({
    h: x.h, mp: x.p, w: Math.pow(Math.max(x.p, 1e-9), beta),
  }));
  const wsum = items.reduce((s, x) => s + x.w, 0);
  items.forEach((x) => { x.idxNum = x.h.num; });

  const p1 = Array(n).fill(0), p2 = Array(n).fill(0), p3 = Array(n).fill(0);
  const exacta = {};        // "i-j" -> P(i1着,j2着)
  const trio = {};          // "a-b-c"(昇順) -> P(その3頭がtop3)
  const trifecta = [];      // {key:"i-j-k", prob}
  const triMap = {};        // "i-j-k"(着順) -> 確率（EV照合用）
  const quinella = {};      // "a-b"(昇順) -> P(top2がその2頭)

  for (let i = 0; i < n; i++) {
    const wi = items[i].w, W1 = wsum - wi;
    p1[i] = wi / wsum;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const wj = items[j].w, W2 = W1 - wj;
      const pij = (wi / wsum) * (wj / W1);    // P(i1着,j2着)
      p2[j] += pij;
      exacta[items[i].idxNum + "-" + items[j].idxNum] = pij;
      const qk = pairKey(items[i].idxNum, items[j].idxNum);
      quinella[qk] = (quinella[qk] || 0) + pij;   // i-j と j-i を合算→馬連
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const pijk = pij * (items[k].w / W2);
        p3[k] += pijk;
        const tkey = items[i].idxNum + "-" + items[j].idxNum + "-" + items[k].idxNum;
        trifecta.push({ key: tkey, prob: pijk });
        triMap[tkey] = pijk;
        const tk = trioKey(items[i].idxNum, items[j].idxNum, items[k].idxNum);
        trio[tk] = (trio[tk] || 0) + pijk;        // 6通り合算→3連複
      }
    }
  }
  // ワイド（2頭ともtop3）は専用に厳密計算する
  const wideExact = computeWideExact(items, wsum);
  const depth = placeDepth(n);

  items.forEach((x, i) => {
    x.p1 = p1[i] * 100;                  // AI勝率（バイアス補正後）
    x.p2 = p2[i] * 100;
    x.p3 = p3[i] * 100;
    x.marketP1 = x.mp * 100;             // 市場勝率（オッズそのまま）
    x.top2 = (p1[i] + p2[i]) * 100;     // 連対率
    x.in3model = (p1[i] + p2[i] + p3[i]) * 100; // PLによる3着内率
    x.in3 = x.in3model;
  });
  // 市場複勝オッズで複勝率を補正（複勝プールは単勝由来PLより鋭いことが多い）
  blendPlace(items, depth);

  items.sort((a, b) => b.p1 - a.p1);
  trifecta.sort((a, b) => b.prob - a.prob);

  return {
    items, n, beta, depth, exacta, trio, wide: wideExact, quinella, trifecta, triMap,
    pools: pools || null, basis: mk.basis, overround: mk.overround,
  };
}

// 市場の複勝オッズ（複勝プール）を使って各馬の3着内率を補正する。
// 複勝オッズの逆数を正規化（合計=複勝圏頭数 depth）したものが市場の複勝率の推定。
function blendPlace(items, depth) {
  const inv = items.map((x) => { const po = placeOddsOf(x.h); return po ? 1 / po.avg : null; });
  const have = inv.filter((v) => v != null);
  if (have.length < Math.max(2, items.length - 3)) { items.forEach((x) => { x.marketIn3 = null; }); return; }
  const s = have.reduce((a, b) => a + b, 0);
  items.forEach((x, i) => {
    if (inv[i] != null) {
      const mkt = clamp(inv[i] / s * depth * 100, 0, 99);
      x.marketIn3 = mkt;
      x.in3 = clamp(0.55 * mkt + 0.45 * x.in3model, x.top2, 99.5); // 市場寄りに混合（連対率は下回らない）
    } else {
      x.marketIn3 = null;
    }
  });
}

// ワイド（2頭がともにtop3）の厳密確率を直接計算
// P({a,b}⊆top3) = Σ_{c≠a,b} P(top3集合={a,b,c})
function computeWideExact(items, W) {
  const n = items.length, wide = {};
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    let prob = 0;
    for (let c = 0; c < n; c++) {
      if (c === a || c === b) continue;
      prob += trioSetProb(items, W, a, b, c);
    }
    wide[pairKey(items[a].idxNum, items[b].idxNum)] = prob;
  }
  return wide;
}
// 3頭 {a,b,c}（index）が top3 を占める確率（6順列の和）
function trioSetProb(items, W, a, b, c) {
  const perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
  let p = 0;
  for (const [x, y, z] of perms) {
    const wx = items[x].w, wy = items[y].w, wz = items[z].w;
    p += (wx / W) * (wy / (W - wx)) * (wz / (W - wx - wy));
  }
  return p;
}

function pairKey(a, b) { return a < b ? a + "-" + b : b + "-" + a; }
function trioKey(a, b, c) { return [a, b, c].sort((x, y) => x - y).join("-"); }

/* --------- オッズプール照合（実オッズ→期待値EV） --------- */
function pad2(n) { return String(n).padStart(2, "0"); }
function uKey(a, b) { const x = [a, b].sort((p, q) => p - q); return pad2(x[0]) + pad2(x[1]); }            // 馬連/ワイド/枠連キー
function tKey(a, b, c) { const x = [a, b, c].sort((p, q) => p - q); return pad2(x[0]) + pad2(x[1]) + pad2(x[2]); } // 3連複キー
function oKey(a, b, c) { return pad2(a) + pad2(b) + pad2(c); }                                            // 3連単キー（着順）
function poolOdds(pool, key, mid) {
  if (!pool) return null;
  const v = pool[key];
  if (v == null) return null;
  return Array.isArray(v) ? (mid ? (v[0] + v[1]) / 2 : v[0]) : v;
}
// combos: [{prob: 小数, odds: 倍}] → 1点100円×点数 に対する期待回収倍率（>1で理論プラス）
function evRatio(combos) {
  let exp = 0, valid = 0;
  for (const c of combos) { if (c.odds > 0) { exp += c.prob * c.odds; valid++; } }
  return valid ? exp / combos.length : null;
}

/* ----------------------------- 買い目組み立て ------------------------------ */
// 出走頭数に応じた複勝/ワイドの「○着以内」
function placeDepth(n) { return n >= 8 ? 3 : (n >= 5 ? 2 : 1); }

// ◎○▲… の印
const MARKS = ["◎", "○", "▲", "△", "☆", "△", "△", "", "", "", "", "", "", "", "", "", "", ""];

// 「勝ちやすい買い目」群を生成
function buildBets(A, race) {
  const ranked = A.items;
  const n = A.n;
  const depth = placeDepth(n);
  const bets = [];

  // 1) 本命の複勝（最も堅い）
  const o = ranked[0];
  if (depth >= 2) {
    const hit = o.in3;
    const odds = placeOddsOf(o.h);
    bets.push({
      cat: "tetsuban",
      label: "本命◎の複勝",
      desc: numName(o) + " が" + depth + "着以内",
      tickets: [chip(o, 0)],
      pts: 1, hit,
      payHint: odds ? odds.avg : null,
      ev: odds ? hit / 100 * odds.avg : null,
    });
  }
  // 単勝（本命）
  {
    const hit = o.p1;
    bets.push({
      cat: "tan",
      label: "本命◎の単勝",
      desc: numName(o) + " が1着",
      tickets: [chip(o, 0)],
      pts: 1, hit,
      payHint: o.h.win_odds || null,
      ev: o.h.win_odds ? hit / 100 * o.h.win_odds : null,
    });
  }
  // 2) 上位3頭ワイドBOX（3点）
  if (n >= 4 && ranked.length >= 3) {
    const top3 = ranked.slice(0, 3);
    const pairs = [[0, 1], [0, 2], [1, 2]];
    const wsum = pairs.reduce((s, [a, b]) => s + (A.wide[pairKey(top3[a].idxNum, top3[b].idxNum)] || 0), 0);
    const all3 = trioSetProb(A.items, sumW(A), idxOf(A, top3[0]), idxOf(A, top3[1]), idxOf(A, top3[2]));
    const hit = (wsum - 2 * all3) * 100; // 少なくとも1点的中＝3頭中2頭以上が複勝圏
    const combos = pairs.map(([a, b]) => ({
      prob: A.wide[pairKey(top3[a].idxNum, top3[b].idxNum)] || 0,
      odds: poolOdds(A.pools && A.pools.wide, uKey(top3[a].idxNum, top3[b].idxNum), true),
    }));
    bets.push({
      cat: "wide", label: "上位3頭 ワイドBOX",
      desc: "◎○▲ から2頭が" + depth + "着以内（3点）",
      tickets: top3.map((x, i) => chip(x, i)),
      pts: 3, hit, ev: evRatio(combos), fair: breakeven(3, hit),
    });
  }
  // 3) 馬連 ◎流し
  if (n >= 5 && ranked.length >= 3) {
    const partners = ranked.slice(1, 4);
    let hit = 0;
    const combos = partners.map((pp) => {
      const prob = A.quinella[pairKey(ranked[0].idxNum, pp.idxNum)] || 0;
      hit += prob * 100;
      return { prob, odds: poolOdds(A.pools && A.pools.umaren, uKey(ranked[0].idxNum, pp.idxNum)) };
    });
    bets.push({
      cat: "umaren", label: "馬連 ◎流し",
      desc: numName(ranked[0]) + " → " + partners.map((x) => x.idxNum).join("・") + "（" + partners.length + "点）",
      tickets: [chip(ranked[0], 0), ...partners.map((x, i) => chip(x, i + 1))],
      pts: partners.length, hit, ev: evRatio(combos), fair: breakeven(partners.length, hit),
    });
  }
  // （3連複は専用セクション「3連複 的中率重視プラン」で詳しく扱う）
  // 5) 3連単 フォーメーション（効率フロンティアから高配当向け）
  if (n >= 6 && ranked.length >= 5) {
    const tri = buildTrifectaFormation(A);
    if (tri) bets.push(tri);
  }

  return { bets, depth };
}

function buildTrifectaFormation(A) {
  const ranked = A.items;
  // 候補: 1着[◎] / 2着[◎○▲] / 3着[◎○▲△☆] 等を総当りし、点数あたり的中率の効率フロンティア
  const cands = [];
  for (const n1 of [1, 2]) for (const n2 of [2, 3]) for (const n3 of [3, 4, 5]) {
    if (n2 < n1 || n3 < n2 || n3 > ranked.length) continue;
    const s1 = seq(n1), s2 = seq(n2), s3 = seq(n3);
    const pts = countTrifecta(s1, s2, s3);
    const hit = trifectaHit(A, s1, s2, s3);
    cands.push({ s1, s2, s3, pts, hit });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.pts - b.pts || b.hit - a.hit);
  // 効率の良い一案（的中率/点数 が高め かつ 的中率がそこそこ）
  let best = cands[0];
  for (const c of cands) if (c.hit >= 18 && c.hit / c.pts > best.hit / best.pts) best = c;
  if (best.hit < 10) best = cands.reduce((a, c) => (c.hit > a.hit ? c : a), cands[0]);

  const fmt1 = best.s1.map((i) => chip(ranked[i], i));
  const fmt2 = best.s2.map((i) => chip(ranked[i], i));
  const fmt3 = best.s3.map((i) => chip(ranked[i], i));
  // 実オッズから期待値（フォーメーション内の各着順組合せ）
  const combos = [];
  for (const i of best.s1) for (const j of best.s2) for (const k of best.s3) {
    if (i === j || j === k || i === k) continue;
    const a = ranked[i].idxNum, b = ranked[j].idxNum, c = ranked[k].idxNum;
    combos.push({ prob: A.triMap[a + "-" + b + "-" + c] || 0, odds: poolOdds(A.pools && A.pools.trifecta, oKey(a, b, c)) });
  }
  return {
    cat: "tan3",
    label: "3連単 フォーメーション（高配当）",
    desc: "1着[" + best.s1.map((i) => ranked[i].idxNum).join("・") + "] → 2着[" +
      best.s2.map((i) => ranked[i].idxNum).join("・") + "] → 3着[" +
      best.s3.map((i) => ranked[i].idxNum).join("・") + "]",
    formation: [fmt1, fmt2, fmt3],
    pts: best.pts, hit: best.hit, ev: evRatio(combos),
    fair: breakeven(best.pts, best.hit),
  };
}

function trifectaHit(A, s1, s2, s3) {
  const ranked = A.items;
  const set1 = new Set(s1.map((i) => ranked[i].idxNum));
  const set2 = new Set(s2.map((i) => ranked[i].idxNum));
  const set3 = new Set(s3.map((i) => ranked[i].idxNum));
  let hit = 0;
  for (const { key, prob } of A.trifecta) {
    const [a, b, c] = key.split("-").map(Number);
    if (set1.has(a) && set2.has(b) && set3.has(c) && a !== b && b !== c && a !== c) hit += prob;
  }
  return hit * 100;
}
function countTrifecta(s1, s2, s3) {
  let n = 0;
  for (const a of s1) for (const b of s2) for (const c of s3) if (a !== b && b !== c && a !== c) n++;
  return n;
}

// 損益分岐となる「当たり券の配当(倍)」目安。総額(pts×100円)を的中時に回収する条件。
// 当たり1点と仮定: prob × O × 100 ≥ pts × 100  →  O ≥ pts / prob
function breakeven(pts, hitPercent) {
  const prob = hitPercent / 100;
  return prob > 0 ? pts / prob : null;
}
function sumW(A) { return A.items.reduce((s, x) => s + x.w, 0); }
function idxOf(A, item) { return A.items.indexOf(item); }
function placeOddsOf(h) {
  if (h.place_min == null) return null;
  const max = h.place_max != null ? h.place_max : h.place_min;
  return { min: h.place_min, max, avg: (h.place_min + max) / 2 };
}

/* ----------------------------- 近走スピード指数（参考・確率には不使用） ------------------------------ */
// 直近81Rの回帰から得た基準タイム（秒）。芝/ダの距離一次近似。あくまで参考値。
const GOING_OFF = { "良": 0, "稍": 0.5, "重": 1.0, "不": 1.5 };
function parTimeSec(surface, dist) {
  if (surface === "芝") return 0.0643 * dist - 9.6;
  if (surface === "ダ") return 0.0697 * dist - 13.9;
  return null; // 障害などは対象外
}
// スピード指数：基準タイムより速いほど高い（+10 ≒ 1.0秒速い）
function speedFigure(p) {
  const par = parTimeSec(p.surface, p.dist);
  if (par == null || !p.sec) return null;
  const go = GOING_OFF[p.going] != null ? GOING_OFF[p.going] : 0;
  return Math.round(((par + go) - p.sec) * 10);
}
function pastSummary(past) {
  if (!past || !past.length) return null;
  const figs = past.map(speedFigure).filter((v) => v != null);
  if (!figs.length) return { figs: [], best: null, avg: null, trend: 0 };
  const best = Math.max.apply(null, figs);
  const avg = Math.round(figs.reduce((a, b) => a + b, 0) / figs.length);
  let trend = 0;
  if (figs.length >= 2) {
    const older = figs.slice(1).reduce((a, b) => a + b, 0) / (figs.length - 1);
    trend = Math.round(figs[0] - older); // 前走 − それ以前平均
  }
  return { figs, best, avg, trend };
}

/* ----------------------------- 妙味（期待値プラス）探索 ------------------------------ */
// 各馬券種の実オッズ × モデル確率で期待値を計算し、+EV（割安＝市場の歪み）を発掘する。
// モデル確率は単勝プール由来。各馬券プールがそれと食い違って厚い配当を出している点を拾う。
function valueBets(A) {
  if (!A.pools) return [];
  const R = A.items, out = [];
  const top = R.slice(0, Math.min(8, R.length));   // ノイズ抑制のため上位8頭中心に探索
  const add = (type, tickets, ev, hit, oddsStr) => {
    if (ev != null && isFinite(ev)) out.push({ type, tickets, ev, hit, oddsStr });
  };
  R.forEach((x) => {
    if (x.h.win_odds) add("単勝", [chipOf(x)], (x.p1 / 100) * x.h.win_odds, x.p1, x.h.win_odds + "倍");
    const po = placeOddsOf(x.h);
    if (po) add("複勝", [chipOf(x)], (x.in3 / 100) * po.avg, x.in3, fmt(po.min) + "〜" + fmt(po.max) + "倍");
  });
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const a = top[i], b = top[j];
    const um = poolOdds(A.pools.umaren, uKey(a.idxNum, b.idxNum));
    if (um) { const p = A.quinella[pairKey(a.idxNum, b.idxNum)] || 0; add("馬連", [chipOf(a), chipOf(b)], p * um, p * 100, um + "倍"); }
    const wd = poolOdds(A.pools.wide, uKey(a.idxNum, b.idxNum), true);
    if (wd) { const p = A.wide[pairKey(a.idxNum, b.idxNum)] || 0; add("ワイド", [chipOf(a), chipOf(b)], p * wd, p * 100, fmt(wd) + "倍"); }
  }
  const t7 = R.slice(0, Math.min(7, R.length));
  for (let i = 0; i < t7.length; i++) for (let j = i + 1; j < t7.length; j++) for (let k = j + 1; k < t7.length; k++) {
    const od = poolOdds(A.pools.trio, tKey(t7[i].idxNum, t7[j].idxNum, t7[k].idxNum));
    if (od) { const p = A.trio[trioKey(t7[i].idxNum, t7[j].idxNum, t7[k].idxNum)] || 0; add("3連複", [chipOf(t7[i]), chipOf(t7[j]), chipOf(t7[k])], p * od, p * 100, od + "倍"); }
  }
  return out.filter((v) => v.ev >= 1.05 && v.hit >= 2).sort((a, b) => b.ev - a.ev).slice(0, 6);
}
function chipOf(x) { return { num: x.idxNum, mark: "", name: x.h.name }; }

/* ----------------------------- 3連複プラン（的中率重視・複数の買い方） ------------------------------ */
// すべて A.trio（その3頭がtop3になる厳密確率）を合算 → 的中率。買い目は互いに排他なので単純和でOK。
function buildTrioPlans(A) {
  const n = A.n, plans = [];
  if (n < 4) return plans;
  // 3連複は「3着以内に来るか」が本質。勝率ではなく3着内率(複勝)で並べて選ぶ。
  const P = A.items.slice().sort((a, b) => (b.in3 - a.in3) || (b.p1 - a.p1));
  const numAt = (i) => P[i].idxNum;
  const evalNums = (triples) => {
    let hit = 0; const evc = [];
    for (const t of triples) {
      const pr = A.trio[trioKey(t[0], t[1], t[2])] || 0;
      hit += pr;
      evc.push({ prob: pr, odds: poolOdds(A.pools && A.pools.trio, tKey(t[0], t[1], t[2])) });
    }
    return { hit: hit * 100, ev: evRatio(evc), pts: triples.length };
  };
  const mkAxis1 = (k) => {
    const ax = numAt(0); const part = []; for (let j = 1; j <= k; j++) part.push(numAt(j));
    const tr = []; for (let i = 0; i < part.length; i++) for (let j = i + 1; j < part.length; j++) tr.push([ax, part[i], part[j]]);
    return Object.assign({ kind: "axis1", label: "軸1頭ながし − 相手" + k + "頭",
      rows: [{ label: "軸", nums: [ax] }, { label: "相手", nums: part }] }, evalNums(tr));
  };
  const mkAxis2 = (m) => {
    const a1 = numAt(0), a2 = numAt(1); const part = []; for (let j = 2; j < 2 + m; j++) part.push(numAt(j));
    const tr = part.map((p) => [a1, a2, p]);
    return Object.assign({ kind: "axis2", label: "軸2頭ながし − 相手" + m + "頭",
      rows: [{ label: "軸", nums: [a1, a2] }, { label: "相手", nums: part }] }, evalNums(tr));
  };
  const mkBox = (k) => {
    const idx = []; for (let j = 0; j < k; j++) idx.push(numAt(j));
    const tr = []; for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let c = b + 1; c < k; c++) tr.push([idx[a], idx[b], idx[c]]);
    return Object.assign({ kind: "box", label: "上位" + k + "頭BOX",
      rows: [{ label: "BOX", nums: idx }] }, evalNums(tr));
  };
  for (const k of [3, 4, 5, 6, 7]) if (1 + k <= n) plans.push(mkAxis1(k));
  for (const m of [3, 4, 5, 6]) if (2 + m <= n) plans.push(mkAxis2(m));
  for (const k of [4, 5, 6, 7, 8]) if (k <= n) plans.push(mkBox(k));
  return plans.filter((p) => p.pts <= 56 && p.pts > 0);
}

// 馬番→チップ（印は勝率順位 A.items のランクで付与）
function numChipHTML(A, num) {
  const it = A.items.find((x) => x.idxNum === num);
  const rk = it ? A.items.indexOf(it) : -1;
  return chipHTML({ num, mark: rk >= 0 ? (MARKS[rk] || "") : "", name: it ? it.h.name : "" });
}

function renderTrioPlans(A) {
  const plans = buildTrioPlans(A);
  if (!plans.length) return '<div class="bet-box">3連複の算出に十分な頭数がありません。</div>';
  // 「的中率重視」のおすすめ＝点数36以内で最も的中率が高いもの
  let rec = null;
  for (const p of plans) if (p.pts <= 36) { if (!rec || p.hit > rec.hit) rec = p; }
  if (!rec) rec = plans.slice().sort((a, b) => b.hit - a.hit)[0];
  const sorted = plans.slice().sort((a, b) => b.hit - a.hit || a.pts - b.pts);
  let h = '<div class="bet-note" style="margin-bottom:8px">的中率を上げるほど点数（金額）は増えます。予算に合うものを選んでください。<b>★＝的中率重視のおすすめ</b>。馬の選定は「3着内率（複勝）」基準。</div>';
  h += '<div class="bets">';
  for (const p of sorted) {
    h += '<div class="bet-box bet-fuku3' + (p === rec ? " recommended" : "") + '">';
    h += '<div class="bet-type">' + esc(p.label) +
      (p === rec ? ' <span class="rec-tag">★的中率重視</span>' : "") +
      '<span class="bet-hit">的中率 <b>' + p.hit.toFixed(1) + "%</b></span></div>";
    h += '<div class="fm">';
    for (const row of p.rows) {
      h += '<div class="fm-row"><span class="fm-pos">' + row.label + '</span><span class="fm-chips">' +
        row.nums.map((num) => numChipHTML(A, num)).join("") + "</span></div>";
    }
    h += "</div>";
    h += '<div class="bet-summary">' + p.pts + "点 = <b>" + (p.pts * 100).toLocaleString() + "円</b>（100円/点）";
    if (p.ev != null && isFinite(p.ev)) {
      const roi = (p.ev - 1) * 100;
      h += ' ／ 期待値 <b class="' + (p.ev >= 1 ? "ev" : "") + '">' + p.ev.toFixed(2) + "</b>" +
        '<span class="roi ' + (roi >= 0 ? "pos" : "neg") + '">ROI ' + (roi >= 0 ? "+" : "") + roi.toFixed(0) + "%</span>";
    }
    h += "</div></div>";
  }
  h += '<div class="bet-note">※ 的中率は市場オッズ由来の理論値で、実際はやや割れる（外れる）こともあります。' +
    '<b>頻繁に当てたいなら、複勝・ワイドの併用</b>が有効です（下の「勝ちやすい買い目」参照）。</div>';
  h += "</div>";
  return h;
}

/* ----------------------------- 信頼度スコア（目安） ------------------------------ */
function confidence(A) {
  let c = 58;
  if (A.basis !== "odds") c -= 22;                 // オッズ未発表は信頼低
  if (A.status === "result") c += 8;               // 確定オッズ
  else if (A.status) c += 2;                       // 前売り等
  if (A.overround) c += clamp((1.30 - A.overround) / 0.10 * 8, -8, 8); // 過剰率が低いほど良
  const o = A.items[0];
  c += clamp((o.p1 - 25) / 3, -8, 14);             // 本命が強い＝読みやすい
  c -= clamp((A.n - 10) * 1.0, -4, 9);             // 多頭数は難
  const conc = A.items.slice(0, 3).reduce((s, x) => s + x.p1, 0);
  c += clamp((conc - 55) / 3, -6, 9);              // 上位集中度
  return clamp(Math.round(c), 5, 95);
}
function confLabel(c) { return c >= 70 ? "高" : c >= 50 ? "中" : "低"; }

/* ----------------------------- 描画 ------------------------------ */
function chip(x, rankIdx) {
  return { num: x.idxNum, mark: MARKS[rankIdx] || "", name: x.h.name };
}
function numName(x) { return x.idxNum + "番 " + (x.h.name || ""); }

function renderResult(race, A) {
  lastRender = { race, A };
  const { bets, depth } = buildBets(A, race);
  const ranked = A.items;

  let html = "";

  const conf = confidence(A);

  // ヘッダー
  html += '<div class="race-head">';
  html += '<div class="rh-title">' + esc(race.place) + " " + race.race_no + "R " +
    (race.name ? '<span class="rh-name">' + esc(race.name) + "</span>" : "") +
    '<span class="conf conf-' + confLabel(conf) + '">信頼度 ' + confLabel(conf) + " " + conf + "</span></div>";
  html += '<div class="rh-sub">' +
    (race.course ? esc(race.course) + (race.direction ? "(" + esc(race.direction) + ")" : "") + " ・ " : "") +
    (race.post_time ? "発走 " + esc(race.post_time) + " ・ " : "") +
    A.n + "頭立て ・ " +
    (A.basis === "odds" ? (A.status === "result" ? "確定オッズ" : "オッズ反映") : A.basis === "pop" ? "人気順(オッズ未発表)" : "均等") +
    (A.overround ? "（過剰率 " + Math.round(A.overround * 100) + "%）" : "") +
    "</div>";
  // 文脈チップ（馬場・天候など。確率には混ぜず情報提示）
  const ctx = [];
  if (race.track_condition) ctx.push("🏟️馬場 " + esc(race.track_condition));
  if (race.weather) ctx.push("☁️天候 " + esc(race.weather));
  if (ctx.length) html += '<div class="cond">' + ctx.map((c) => "<span>" + c + "</span>").join("") + "</div>";
  html += "</div>";

  // Claudeの予想（APIキーがあれば本物のClaudeを自動表示／無ければアプリ内分析）
  html += '<div class="claude-comment"><div class="cc-head">🧠 Claudeの予想</div>' +
    '<div class="cc-body"><div id="claudeOut" class="claude-out">' + claudeMainBody() + "</div></div></div>";

  // 3連複 的中率重視プラン（メイン）
  html += '<div class="section-label">🎯 3連複 的中率重視プラン（複数の買い方）</div>';
  html += renderTrioPlans(A);

  // 妙味（期待値プラス）
  const vals = valueBets(A);
  if (vals.length) {
    html += '<div class="section-label">🔥 妙味（実オッズ×AI確率で期待値1.0超＝割安）</div>';
    html += '<div class="bet-box value-box">';
    vals.forEach((v) => {
      html += '<div class="combo-row"><span class="vtype">' + esc(v.type) + "</span>" +
        v.tickets.map(chipHTML).join("") +
        '<span class="value-meta">' + esc(v.oddsStr) + " ／ 的中" + v.hit.toFixed(1) +
        "% ／ <b class='ev'>EV " + v.ev.toFixed(2) + "</b></span></div>";
    });
    html += '<div class="bet-note">※ EV=AI確率×実オッズ。1.0超は理論上プラス（市場の歪み）。当たりやすさ自体は的中率をご覧ください。</div>';
    html += "</div>";
  }

  // 勝ちやすい買い目
  html += '<div class="section-label">💴 勝ちやすい買い目（的中率＝厳密確率／EV=実オッズ期待値）</div>';
  html += '<div class="bets">';
  // 堅い順に並べる
  const order = { tetsuban: 0, wide: 1, umaren: 2, fuku3: 3, tan: 4, tan3: 5 };
  bets.sort((a, b) => (order[a.cat] - order[b.cat]));
  for (const b of bets) html += betCard(b);
  html += "</div>";

  // 各馬の確率表
  html += '<div class="section-label">🐎 各馬の確率（市場オッズ＋バイアス補正）</div>';
  const maxP1 = Math.max(ranked[0].p1, 1);
  ranked.forEach((x, i) => { html += horseCard(x, i, maxP1, depth); });

  // 3連単 確率上位
  html += '<div class="section-label">📊 3連単 確率上位</div>';
  html += renderTopTrifecta(A);

  resultEl.innerHTML = html;
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  // APIキーがあれば、このレースを未取得のとき自動でClaude予想を実行（全自動）
  if (getClaudeKey() && curRaceId() && !getClaudeSaved(curRaceId())) setTimeout(runClaude, 30);
}

function betCard(b) {
  let h = '<div class="bet-box bet-' + b.cat + '">';
  h += '<div class="bet-type">' + esc(b.label) +
    '<span class="bet-hit">的中率 <b>' + b.hit.toFixed(1) + "%</b></span></div>";
  h += '<div class="bet-desc">' + esc(b.desc) + "</div>";
  // 買い目チップ
  if (b.formation) {
    const lab = ["1着", "2着", "3着"];
    h += '<div class="fm">';
    b.formation.forEach((row, i) => {
      h += '<div class="fm-row"><span class="fm-pos">' + lab[i] + '</span><span class="fm-chips">' +
        row.map(chipHTML).join("") + "</span></div>";
    });
    h += "</div>";
  } else if (b.tickets) {
    h += '<div class="fm-chips ticket-chips">' + b.tickets.map(chipHTML).join("") + "</div>";
  }
  // サマリー
  h += '<div class="bet-summary">' + b.pts + "点 = <b>" + (b.pts * 100).toLocaleString() + "円</b>（100円/点）";
  if (b.ev != null && isFinite(b.ev)) {
    const roi = (b.ev - 1) * 100;
    h += ' ／ 期待値 <b class="' + (b.ev >= 1 ? "ev" : "") + '">' + b.ev.toFixed(2) + "</b>" +
      '<span class="roi ' + (roi >= 0 ? "pos" : "neg") + '">ROI ' + (roi >= 0 ? "+" : "") + roi.toFixed(0) + "%</span>";
  } else if (b.payHint != null) {
    h += " ／ 参考配当 " + fmt(b.payHint) + "倍";
  } else if (b.fair != null) {
    h += " ／ 分岐配当 " + fmt(b.fair) + "倍以上で妙味";
  }
  h += "</div></div>";
  return h;
}

function chipHTML(c) {
  return '<span class="hchip waku" title="' + esc(c.name || "") + '">' +
    (c.mark ? '<span class="cmark">' + c.mark + "</span>" : "") +
    '<span class="cnum">' + c.num + "</span>" +
    (c.name ? '<span class="cname">' + esc(c.name) + "</span>" : "") + "</span>";
}

function horseCard(x, i, maxP1, depth) {
  const h = x.h;
  const mark = MARKS[i] || "";
  const barW = (x.p1 / maxP1 * 100).toFixed(0);
  const po = placeOddsOf(h);
  let s = '<div class="horse-card">';
  s += '<div class="rank-mark">' + mark + "</div>";
  s += '<div class="num-badge">' + x.idxNum + "</div>";
  s += '<div class="horse-info">';
  s += '<div class="horse-name">' + esc(h.name || "") +
    (h.sexage ? '<span class="sexage">' + esc(h.sexage) + "</span>" : "") +
    (h.popularity ? '<span class="pop">' + h.popularity + "番人気</span>" : "") + "</div>";
  const wdiff = (h.weight_diff != null)
    ? '（' + (h.weight_diff > 0 ? "+" : "") + h.weight_diff + (Math.abs(h.weight_diff) >= 12 ? "⚠" : "") + '）' : "";
  s += '<div class="horse-meta">' +
    (h.waku ? '<span class="waku-dot waku-' + h.waku + '">' + h.waku + "枠</span> " : "") +
    (h.jockey ? esc(h.jockey) + " ／ " : "") +
    "単 " + (h.win_odds ? fmt(h.win_odds) + "倍" : "-") +
    (po ? " ／ 複 " + fmt(po.min) + (po.max !== po.min ? "-" + fmt(po.max) : "") + "倍" : "") +
    (h.weight ? " ／ 馬体重 " + h.weight + wdiff : "") + "</div>";
  s += '<div class="score-bar"><div style="width:' + barW + '%"></div></div>';
  s += "</div>";
  s += '<div class="horse-prob"><span class="prob-val">' + x.p1.toFixed(1) + '%</span><span class="prob-label">勝率</span></div>';
  s += '<div class="horse-detail">' +
    "<span>市場勝率 <b>" + x.marketP1.toFixed(1) + "%</b></span>" +
    "<span>連対率 <b>" + x.top2.toFixed(1) + "%</b></span>" +
    "<span>" + depth + "着内率 <b>" + x.in3.toFixed(1) + "%</b></span>" +
    (h.win_odds ? "<span>単勝期待値 <b class='" + ((x.p1 / 100 * h.win_odds) >= 1 ? "ev" : "") + "'>" +
      (x.p1 / 100 * h.win_odds).toFixed(2) + "</b></span>" : "") +
    "</div>";
  s += renderPast(h);
  s += "</div>";
  return s;
}

// 近走（参考情報）。確率計算には使わない。
function renderPast(h) {
  const past = h.past;
  if (!past || !past.length) return "";
  const sum = pastSummary(past);
  let badge = "";
  if (sum && sum.trend >= 5) badge = '<span class="trend up">↑上昇</span>';
  else if (sum && sum.trend <= -5) badge = '<span class="trend down">↓下降</span>';
  let html = '<details class="past"><summary>📋 近走（参考）' +
    (sum && sum.best != null ? ' <span class="figbest">指数best ' + sum.best + "</span>" : "") + badge + "</summary>";
  html += '<div class="past-list">';
  past.forEach((p) => {
    const f = speedFigure(p);
    html += '<div class="past-row">' +
      '<span class="pdate">' + esc((p.ymd || "").slice(5)) + "</span>" +
      '<span class="pcourse">' + esc(p.place) + " " + esc(p.surface) + p.dist + esc(p.going || "") + "</span>" +
      '<span class="pmeta">' + (p.field ? p.field + "頭" : "") + (p.pop ? " " + p.pop + "人気" : "") +
      (p.agari != null ? " 上り" + p.agari : "") + (p.bdiff != null ? " 体" + (p.bdiff > 0 ? "+" : "") + p.bdiff : "") + "</span>" +
      '<span class="pfig">' + (f != null ? "指数" + f : "") + "</span>" +
      "</div>";
  });
  html += '<div class="bet-note">※ 指数=基準タイム比の参考値（馬場/クラス未補正）。予想確率には使っていません。</div>';
  html += "</div></details>";
  return html;
}

function renderTopTrifecta(A) {
  let h = '<div class="bet-box">';
  A.trifecta.slice(0, 8).forEach((c, idx) => {
    const [a, b, cc] = c.key.split("-").map(Number);
    h += '<div class="combo-row"><span class="combo-rank">' + (idx + 1) + "</span>" +
      '<span class="hchip waku"><span class="cnum">' + a + "</span></span><span class='combo-arrow'>→</span>" +
      '<span class="hchip waku"><span class="cnum">' + b + "</span></span><span class='combo-arrow'>→</span>" +
      '<span class="hchip waku"><span class="cnum">' + cc + "</span></span>" +
      '<span class="combo-prob">' + (c.prob * 100).toFixed(2) + "%</span></div>";
  });
  h += '<div class="bet-note">※ この並びで決まる厳密確率（市場オッズ基準）。理論オッズ≒100÷確率。</div></div>';
  return h;
}

// アプリ内で生成する「AIの総合分析」。市場確率＋近走指数等から自然文の予想を組み立てる。
// （Maxプランは外部から自動呼び出しできず、APIも使わない方針のため、本アプリのエンジンで生成）
function aiAnalysisHTML(race, A) {
  const R = A.items, depth = A.depth;
  const o = R[0], t = R[1], s = R[2];
  const conc = R.slice(0, 3).reduce((a, x) => a + x.p1, 0);
  const sec = (label, body) => '<div class="ai-sec"><b>' + label + '</b>' + body + "</div>";

  // 各馬の所見（利用できるデータだけで）
  const note = (x) => {
    const h = x.h, ps = pastSummary(h.past), n = [];
    if (ps && ps.best != null) n.push("近走指数" + ps.best + (ps.trend >= 5 ? "↑上昇" : ps.trend <= -5 ? "↓下降" : ""));
    if (h.weight_diff != null && Math.abs(h.weight_diff) >= 12) n.push("馬体重" + (h.weight_diff > 0 ? "大幅増(+" + h.weight_diff + ")" : "大幅減(" + h.weight_diff + ")"));
    if (h.jockey) n.push(esc(h.jockey));
    return n.length ? "（" + n.join("・") + "）" : "";
  };
  const nm = (x) => x.idxNum + "番 " + esc(x.h.name || "");

  let h = "";

  // 構図
  let katachi;
  if (o.p1 >= 35) katachi = "本命" + nm(o) + "が抜けた信頼度の高い一戦。堅く獲りにいける。";
  else if (o.p1 < 22) katachi = "上位が拮抗し頭が割れやすい難解戦。波乱含みで点数を広げたい。";
  else katachi = "標準的な堅さ。上位数頭の力が接近しており、◎軸の3連複で手広くが妥当。";
  katachi += "（上位3頭で勝率合計" + conc.toFixed(0) + "%、" + A.n + "頭立て";
  if (race.track_condition && race.track_condition !== "良") katachi += "・馬場" + esc(race.track_condition);
  katachi += "）";
  h += sec("構図　", katachi);

  // 本命・対抗・単穴
  h += sec("◎本命　", nm(o) + " — 勝率" + o.p1.toFixed(0) + "%・" + depth + "着内率" + o.in3.toFixed(0) + "% " + note(o));
  if (t) h += sec("◯対抗　", nm(t) + " — 勝率" + t.p1.toFixed(0) + "% " + note(t));
  if (s) h += sec("▲単穴　", nm(s) + " — 勝率" + s.p1.toFixed(0) + "% " + note(s));

  // ヒモ
  const himo = R.slice(3, Math.min(6, R.length));
  if (himo.length) h += sec("△ヒモ　", himo.map((x) => x.idxNum + "番" + esc(x.h.name || "")).join("、"));

  // 妙味（近走指数が上昇 or 上位級なのに人気が無い馬）
  const oBest = (pastSummary(o.h.past) || {}).best;
  let value = null;
  for (const x of R.slice(3, 9)) {
    const ps = pastSummary(x.h.past);
    if (ps && (ps.trend >= 5 || (ps.best != null && oBest != null && ps.best >= oBest))) { value = x; break; }
  }
  if (value) h += sec("🔥妙味　", nm(value) + " — 人気の盲点になりやすいが近走内容は上位級。ヒモ穴に一考" + note(value));

  // 推奨買い目（3連複）
  const plans = buildTrioPlans(A).sort((a, b) => b.hit - a.hit);
  let rec = null, eff = -1;
  for (const p of plans) { const e = p.hit / p.pts; if (p.hit >= 40 && e > eff) { eff = e; rec = p; } }
  if (!rec && plans.length) rec = plans[0];
  if (rec) {
    const members = rec.rows.map((row) => row.label + "[" + row.nums.join("・") + "]").join(" ");
    h += sec("🎯推奨　", "3連複 " + esc(rec.label) + "（" + members + "）＝ " + rec.pts + "点・的中率" + rec.hit.toFixed(0) + "%。" +
      "堅実に当てるなら◎の複勝も併用。");
  }

  // リスク
  let risk;
  if (o.p1 >= 35) risk = "本命の取りこぼし時は配当妙味が薄い。崩れる場合は人気薄の台頭に注意。";
  else risk = "上位拮抗ゆえ3着内の取りこぼしが起きやすい。手広く構えるか、ワイドで保険を。";
  h += sec("⚠️リスク　", risk);

  h += '<div class="ai-disc">※ 市場オッズを基準にした自動分析です。競馬は分散が大きく的中を保証しません。' +
    'さらに踏み込んだ読みは下の「claude.ai に相談」をご利用ください。</div>';
  return h;
}

function raceComment(ranked, depth, A) {
  const o = ranked[0], t = ranked[1], s = ranked[2];
  let txt = (A.basis === "odds" ? "【確定オッズ反映】" : A.basis === "pop" ? "【オッズ未発表・人気順で暫定】" : "【参考】");
  txt += "本命は" + numName(o) + "（勝率" + o.p1.toFixed(0) + "%・" + depth + "着内率" + o.in3.toFixed(0) + "%）。";
  if (t) txt += "対抗は" + numName(t) + "、3番手に" + (s ? numName(s) : "") + "。";
  if (o.p1 >= 40) txt += " 本命が抜けており複勝・ワイドで堅く獲りにいけるレース。";
  else if (o.p1 < 22) txt += " 上位拮抗で頭が割れやすく、ワイド・3連複の点数を広げたい難解戦。";
  else txt += " 標準的な堅さ。◎軸の3連複が狙いやすい。";
  return txt;
}

/* ----------------------------- ユーティリティ ------------------------------ */
function fmt(v) { return v == null ? "-" : (Math.round(v * 10) / 10); }
// 日本時間で offsetDays 日後の YYYY-MM-DD
function ymdJST(offsetDays) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000);
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}
// 選択中の日付を YYYYMMDD で返す（未選択なら本日）
function selectedDate() {
  const v = dateSel && dateSel.value ? dateSel.value : ymdJST(0);
  return v.replace(/-/g, "");
}
function fmtDate(d) {
  if (!d || d.length !== 8) return d || "";
  return d.slice(0, 4) + "/" + d.slice(4, 6) + "/" + d.slice(6, 8);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function setStatus(html, isError) {
  statusEl.innerHTML = html;
  statusEl.className = "status" + (isError ? " error" : "");
}

/* ----------------------------- イベント ------------------------------ */
venueSel.addEventListener("change", populateRaces);

async function runPrediction() {
  const raceId = raceSel.value;
  if (!raceId) return;
  const m = MEETINGS[Number(venueSel.value)];
  const race = m && m.races.find((r) => r.race_id === raceId);
  setStatus('<div class="spinner"></div>最新オッズ・出走表を取得中…');
  try {
    let detail = RACE_CACHE.get(raceId);
    if (!detail) {
      const res = await fetch(proxyGet("race_id=" + raceId), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      detail = await res.json();
      if (detail.error) throw new Error(detail.error);
      RACE_CACHE.set(raceId, detail);
    }
    // 一覧側のメタで補完
    const meta = Object.assign({}, detail);
    if (race) {
      meta.name = detail.name || race.name;
      meta.course = detail.course || race.course;
      meta.post_time = detail.post_time || race.post_time;
      meta.place = detail.place || race.place;
    }
    if (!detail.horses || detail.horses.length < 2) {
      setStatus("このレースの出走データを取得できませんでした（発走前でオッズ未掲載の可能性）。", true);
      return;
    }
    const A = analyze(detail.horses, detail.pools);
    A.status = detail.odds_status || "";
    if (A.n < 2) { setStatus("確率計算に必要なオッズ/出走データが不足しています。", true); return; }
    setStatus("");
    renderResult(meta, A);
  } catch (e) {
    setStatus("予想の取得に失敗しました。<br><small>" + esc((e && e.message) || e) + "</small>", true);
  }
}

predictBtn.addEventListener("click", () => runPrediction());

const refreshBtn = $("refresh");
if (refreshBtn) refreshBtn.addEventListener("click", () => {
  const v = venueSel.value, r = raceSel.value;
  RACE_CACHE.delete(r);
  refreshBtn.disabled = true;
  loadData().then(() => {
    if (v) { venueSel.value = v; populateRaces(); if (r) raceSel.value = r; }
    if (!resultEl.hidden && raceSel.value) runPrediction();
    refreshBtn.disabled = false;
  });
});

const proxyInput = $("proxyUrl");
if (proxyInput) {
  proxyInput.value = (function () { try { return localStorage.getItem(PROXY_KEY) || ""; } catch { return ""; } })() || "";
  const save = () => { setProxyUrl(proxyInput.value); if (getProxyUrl() && !MEETINGS.length) loadData(); };
  proxyInput.addEventListener("change", save);
  proxyInput.addEventListener("blur", save);
}

// Anthropic APIキー（任意・自動実行用）
const claudeKeyInput = $("claudeKey");
if (claudeKeyInput) {
  claudeKeyInput.value = getClaudeKey();
  const saveK = () => setClaudeKey(claudeKeyInput.value);
  claudeKeyInput.addEventListener("change", saveK);
  claudeKeyInput.addEventListener("blur", saveK);
}

// Claudeボタン（プロンプトコピー／任意のAPI自動実行）の委譲ハンドラ
resultEl.addEventListener("click", (e) => {
  const id = e.target && e.target.id;
  if (id === "copyClaude") copyClaudePrompt();
  else if (id === "askClaude") runClaude();
  else if (id === "saveClaude") saveClaudeReply();
  else if (id === "editClaude") editClaudeReply();
});

// 日付選択（既定=本日JST。前後の日付も選べる）
if (dateSel) {
  if (!dateSel.value) dateSel.value = ymdJST(0);
  dateSel.min = ymdJST(-7);
  dateSel.max = ymdJST(8);
  dateSel.addEventListener("change", () => {
    resultEl.hidden = true;
    raceSel.innerHTML = "";
    venueSel.innerHTML = "";
    loadData();
  });
}

// スタンス変更 → 表示中レースを即再計算
if (stanceSel) stanceSel.addEventListener("change", () => {
  if (!resultEl.hidden && raceSel.value) runPrediction();
});

const verEl = $("version");
if (verEl) verEl.textContent = "ビルド: " + APP_VERSION;

loadData();
