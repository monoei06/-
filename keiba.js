"use strict";

/* ===========================================================================
 * 中央競馬(JRA) AI予想アプリ
 * netkeiba の公開オッズ・出走表を、データサーバー(Cloudflare Worker)経由で取得し、
 * 「市場オッズから過剰率(控除)を除いた厳密な勝率」を基準に、Plackett–Luce の閉形式で
 * 単勝/複勝/馬連/ワイド/馬単/3連複/3連単の的中確率と期待値を計算する静的アプリ。
 * バックエンドは小さなプロキシ(worker/keiba-proxy.js)のみ。
 * =========================================================================== */

const APP_VERSION = "2026-06-13 競馬AI予想 v1";

// データサーバー(Cloudflare Worker)の既定URL。未デプロイなら ⚙️ で各自設定。
const DEFAULT_PROXY_URL = "https://keiba.komemonoei.workers.dev/";
const PROXY_KEY = "keiba_proxy_url";

// 本命-大穴バイアス補正の指数（favorite-longshot bias）。
// 競馬では「本命はオッズが示すより実際に多く勝ち、大穴は過剰人気で負けやすい」ことが
// 長年実証されている。市場勝率 p を p^BETA に補正（BETA>1 で本命を引き上げる）。
// 1.0=無補正(市場どおり)、1.15 前後が経験的に妥当。
const BETA = 1.15;

const $ = (id) => document.getElementById(id);
const venueSel = $("venue");
const raceSel = $("race");
const predictBtn = $("predict");
const statusEl = $("status");
const resultEl = $("result");

let MEETINGS = [];           // [{place, place_code, meeting, races:[...]}]
let RACE_CACHE = new Map();  // race_id -> detail

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
  setStatus('<div class="spinner"></div>本日の開催・レースを取得中…');
  try {
    const res = await fetch(proxyGet("date="), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    MEETINGS = Array.isArray(j.meetings) ? j.meetings : [];
    if (!MEETINGS.length) {
      setStatus("本日(" + (j.date || "") + ")は中央競馬の開催が見つかりませんでした。", true);
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
function analyze(horses) {
  const mk = marketProbs(horses);
  const items = mk.items.map((x) => ({
    h: x.h, mp: x.p, w: Math.pow(Math.max(x.p, 1e-9), BETA),
  }));
  const n = items.length;
  const W = items.reduce((s, x) => s + x.w, 0);

  const p1 = Array(n).fill(0), p2 = Array(n).fill(0), p3 = Array(n).fill(0);
  const exacta = {};        // "i-j" -> P(i1着,j2着)
  const trio = {};          // "a-b-c"(昇順) -> P(その3頭がtop3)
  const trifecta = [];      // {key:"i-j-k", prob}
  const quinella = {};      // "a-b"(昇順) -> P(top2がその2頭)

  items.forEach((x) => { x.idxNum = x.h.num; });
  const wsum = W;
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
        trifecta.push({ key: items[i].idxNum + "-" + items[j].idxNum + "-" + items[k].idxNum, prob: pijk });
        const tk = trioKey(items[i].idxNum, items[j].idxNum, items[k].idxNum);
        trio[tk] = (trio[tk] || 0) + pijk;        // 6通り合算→3連複
      }
    }
  }
  // ワイド（2頭ともtop3）は専用に厳密計算する
  const wideExact = computeWideExact(items, wsum);

  items.forEach((x, i) => {
    x.p1 = p1[i] * 100;                  // AI勝率（バイアス補正後）
    x.p2 = p2[i] * 100;
    x.p3 = p3[i] * 100;
    x.marketP1 = x.mp * 100;             // 市場勝率（オッズそのまま）
    x.top2 = (p1[i] + p2[i]) * 100;     // 連対率
    x.in3 = (p1[i] + p2[i] + p3[i]) * 100; // 3着内率(複勝圏)
  });
  items.sort((a, b) => b.p1 - a.p1);
  trifecta.sort((a, b) => b.prob - a.prob);

  return { items, n, exacta, trio, wide: wideExact, quinella, trifecta, basis: mk.basis, overround: mk.overround };
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
    bets.push({
      cat: "wide",
      label: "上位3頭 ワイドBOX",
      desc: "◎○▲ から2頭が" + depth + "着以内（3点）",
      tickets: top3.map((x, i) => chip(x, i)),
      pts: 3, hit,
      fair: breakeven(3, hit), // この配当以上で買えば理論上プラス
    });
  }
  // 3) 馬連 上位（◎-○○▲ 流し / BOX）
  if (n >= 5 && ranked.length >= 3) {
    const partners = ranked.slice(1, 4);
    const tickets = [chip(ranked[0], 0)];
    let hit = 0;
    partners.forEach((pp, i) => { hit += (A.quinella[pairKey(ranked[0].idxNum, pp.idxNum)] || 0) * 100; });
    bets.push({
      cat: "umaren",
      label: "馬連 ◎流し",
      desc: numName(ranked[0]) + " → " + partners.map((x) => x.idxNum).join("・") + "（" + partners.length + "点）",
      tickets: [chip(ranked[0], 0), ...partners.map((x, i) => chip(x, i + 1))],
      pts: partners.length, hit,
      fair: breakeven(partners.length, hit),
    });
  }
  // 4) 3連複 ◎軸流し（相手4頭→6点）
  if (n >= 6 && ranked.length >= 5) {
    const axis = ranked[0];
    const partners = ranked.slice(1, 5);
    let hit = 0;
    const combos = [];
    for (let i = 0; i < partners.length; i++) for (let j = i + 1; j < partners.length; j++) {
      const tk = trioKey(axis.idxNum, partners[i].idxNum, partners[j].idxNum);
      hit += (A.trio[tk] || 0) * 100;
      combos.push(tk);
    }
    bets.push({
      cat: "fuku3",
      label: "3連複 ◎軸流し",
      desc: numName(axis) + " 軸 − 相手" + partners.map((x) => x.idxNum).join("・") + "（6点）",
      tickets: [chip(axis, 0), ...partners.map((x, i) => chip(x, i + 1))],
      pts: combos.length, hit,
      fair: breakeven(combos.length, hit),
    });
  }
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
  return {
    cat: "tan3",
    label: "3連単 フォーメーション（高配当）",
    desc: "1着[" + best.s1.map((i) => ranked[i].idxNum).join("・") + "] → 2着[" +
      best.s2.map((i) => ranked[i].idxNum).join("・") + "] → 3着[" +
      best.s3.map((i) => ranked[i].idxNum).join("・") + "]",
    formation: [fmt1, fmt2, fmt3],
    pts: best.pts, hit: best.hit,
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

/* ----------------------------- 描画 ------------------------------ */
function chip(x, rankIdx) {
  return { num: x.idxNum, mark: MARKS[rankIdx] || "", name: x.h.name };
}
function numName(x) { return x.idxNum + "番 " + (x.h.name || ""); }

function renderResult(race, A) {
  const { bets, depth } = buildBets(A, race);
  const ranked = A.items;

  let html = "";

  // ヘッダー
  html += '<div class="race-head">';
  html += '<div class="rh-title">' + esc(race.place) + " " + race.race_no + "R " +
    (race.name ? '<span class="rh-name">' + esc(race.name) + "</span>" : "") + "</div>";
  html += '<div class="rh-sub">' +
    (race.course ? esc(race.course) + " ・ " : "") +
    (race.post_time ? "発走 " + esc(race.post_time) + " ・ " : "") +
    A.n + "頭立て ・ " +
    (A.basis === "odds" ? "確定オッズ基準" : A.basis === "pop" ? "人気順基準(オッズ未発表)" : "均等基準") +
    (A.overround ? "（市場過剰率 " + Math.round(A.overround * 100) + "%）" : "") +
    "</div></div>";

  // Claude総評
  html += '<div class="claude-comment"><div class="cc-head">🧠 AIの予想</div>' +
    '<div class="cc-body">' + esc(raceComment(ranked, depth, A)) + "</div></div>";

  // 勝ちやすい買い目
  html += '<div class="section-label">💴 勝ちやすい買い目（的中率＝厳密確率）</div>';
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
  if (b.ev != null) h += ' ／ 期待値 <b class="' + (b.ev >= 1 ? "ev" : "") + '">' + b.ev.toFixed(2) + "</b>";
  else if (b.payHint != null) h += " ／ 参考配当 " + fmt(b.payHint) + "倍";
  else if (b.fair != null) h += " ／ 理論オッズ目安 " + fmt(b.fair) + "倍以上で妙味";
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
  s += '<div class="horse-meta">' +
    (h.jockey ? "騎手 " + esc(h.jockey) + " ／ " : "") +
    "単勝 " + (h.win_odds ? fmt(h.win_odds) + "倍" : "-") +
    (po ? " ／ 複勝 " + fmt(po.min) + (po.max !== po.min ? "-" + fmt(po.max) : "") + "倍" : "") + "</div>";
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
  s += "</div>";
  return s;
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
    const A = analyze(detail.horses);
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

const verEl = $("version");
if (verEl) verEl.textContent = "ビルド: " + APP_VERSION;

loadData();
