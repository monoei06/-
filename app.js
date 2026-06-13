"use strict";

/* ===========================================================================
 * ボートレース予想アプリ
 * Boatrace Open API (https://boatraceopenapi.github.io/) の出走表データを
 * ブラウザから直接取得し、独自スコアリングで予想を算出する静的アプリ。
 * バックエンド不要・CORS対応済みなので GitHub Pages 等にそのまま置けます。
 * =========================================================================== */

const PROGRAMS_URL = "https://boatraceopenapi.github.io/programs/v2/today.json";

// 競艇場番号 → 場名
const STADIUMS = {
  1: "桐生", 2: "戸田", 3: "江戸川", 4: "平和島", 5: "多摩川", 6: "浜名湖",
  7: "蒲郡", 8: "常滑", 9: "津", 10: "三国", 11: "びわこ", 12: "住之江",
  13: "尼崎", 14: "鳴門", 15: "丸亀", 16: "児島", 17: "宮島", 18: "徳山",
  19: "下関", 20: "若松", 21: "芦屋", 22: "福岡", 23: "唐津", 24: "大村",
};

// 級別番号 → 表示
const CLASSES = { 1: "A1", 2: "A2", 3: "B1", 4: "B2" };

// グレード番号 → 表示
const GRADES = { 1: "SG", 2: "G1", 3: "G2", 4: "G3", 5: "一般" };

// コース別 1着率の全国平均（％・概算）。インから順に大きい = イン有利を反映。
const COURSE_WIN_RATE = { 1: 55, 2: 14, 3: 13, 4: 11, 5: 6, 6: 3 };

// 予想モデルの重み（合計1.0）。出走表のあらゆる指標を取り込む。
const WEIGHTS = {
  course: 0.26,   // コース（進入）有利度
  nat2:   0.18,   // 全国2連対率
  nat1:   0.10,   // 全国勝率
  nat3:   0.04,   // 全国3連対率
  local2: 0.08,   // 当地2連対率
  local1: 0.04,   // 当地勝率
  start:  0.10,   // 平均スタートタイミング
  motor2: 0.08,   // モーター2連対率
  motor3: 0.03,   // モーター3連対率
  boat2:  0.03,   // ボート2連対率
  cls:    0.06,   // 級別
};

// モンテカルロ・シミュレーション設定
const SIM_RUNS = 20000;  // 試行回数（多いほど安定）
const T_SIM = 13;        // 強さの温度（小さいほど強い艇が勝ちやすい＝差が出る）

const $ = (id) => document.getElementById(id);
const venueSel = $("venue");
const raceSel = $("race");
const predictBtn = $("predict");
const statusEl = $("status");
const resultEl = $("result");

let PROGRAMS = [];          // 全プログラム
let byStadium = new Map();  // stadium番号 -> [race,...]

/* ----------------------------- データ取得 ------------------------------ */
async function loadData() {
  setStatus('<div class="spinner"></div>本日の出走表を取得中…');
  try {
    const res = await fetch(PROGRAMS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    PROGRAMS = Array.isArray(json.programs) ? json.programs : [];
    if (!PROGRAMS.length) {
      setStatus("本日のレースデータが見つかりませんでした。開催がない可能性があります。", true);
      return;
    }
    groupByStadium();
    populateVenues();
    setStatus("");
  } catch (e) {
    setStatus("データ取得に失敗しました。通信環境を確認して再読み込みしてください。<br><small>" + e.message + "</small>", true);
  }
}

function groupByStadium() {
  byStadium = new Map();
  for (const p of PROGRAMS) {
    if (!byStadium.has(p.race_stadium_number)) byStadium.set(p.race_stadium_number, []);
    byStadium.get(p.race_stadium_number).push(p);
  }
  for (const list of byStadium.values()) list.sort((a, b) => a.race_number - b.race_number);
}

/* ----------------------------- セレクト構築 ----------------------------- */
function populateVenues() {
  const ids = [...byStadium.keys()].sort((a, b) => a - b);
  venueSel.innerHTML = "";
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = (STADIUMS[id] || "場" + id) + "（" + byStadium.get(id).length + "R）";
    venueSel.appendChild(opt);
  }
  venueSel.disabled = false;
  populateRaces();
}

function populateRaces() {
  const list = byStadium.get(Number(venueSel.value)) || [];
  raceSel.innerHTML = "";
  for (const r of list) {
    const opt = document.createElement("option");
    opt.value = r.race_number;
    const closed = (r.race_closed_at || "").slice(11, 16);
    opt.textContent = r.race_number + "R" + (closed ? "（締切 " + closed + "）" : "");
    raceSel.appendChild(opt);
  }
  raceSel.disabled = false;
  predictBtn.disabled = false;
}

/* ----------------------------- 予想ロジック ----------------------------- */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 各艇のスコア（0-100目安）を算出。出走表のあらゆる指標を取り込む。
function scoreBoat(b) {
  const lane = b.racer_boat_number;
  const pct = (v) => clamp(v || 0, 0, 100);          // %系（0-100）
  const rate = (v) => clamp((v || 0) / 8 * 100, 0, 100); // 勝率系（概ね0-8）

  const courseScore = (COURSE_WIN_RATE[lane] || 0) / 55 * 100;
  // 平均ST: 0.10秒=満点, 0.25秒=0点（低いほど良い）
  const st = b.racer_average_start_timing;
  const startScore = (st == null) ? 50 : clamp((0.25 - st) / (0.25 - 0.10) * 100, 0, 100);
  const clsScore = { 1: 100, 2: 75, 3: 50, 4: 25 }[b.racer_class_number] || 50;

  let score =
    WEIGHTS.course * courseScore +
    WEIGHTS.nat2   * pct(b.racer_national_top_2_percent) +
    WEIGHTS.nat1   * rate(b.racer_national_top_1_percent) +
    WEIGHTS.nat3   * pct(b.racer_national_top_3_percent) +
    WEIGHTS.local2 * pct(b.racer_local_top_2_percent) +
    WEIGHTS.local1 * rate(b.racer_local_top_1_percent) +
    WEIGHTS.start  * startScore +
    WEIGHTS.motor2 * pct(b.racer_assigned_motor_top_2_percent) +
    WEIGHTS.motor3 * pct(b.racer_assigned_motor_top_3_percent) +
    WEIGHTS.boat2  * pct(b.racer_assigned_boat_top_2_percent) +
    WEIGHTS.cls    * clsScore;

  // フライング・出遅れ減点（事故率・信頼性の低下）
  const fl = (b.racer_flying_count || 0) + (b.racer_late_count || 0);
  score -= fl * 8;

  return Math.max(score, 1);
}

const seq = (n) => Array.from({ length: n }, (_, i) => i);

// モンテカルロ・シミュレーション。
// 各艇の強さ w=exp(score/T) を使い、Plackett-Luce モデルで着順を1着から
// 順に確率抽選する。これを SIM_RUNS 回繰り返し、各艇の着順分布と
// 3連単(1着-2着-3着)の出現頻度を集計する。
function predict(race) {
  const boats = race.boats.map((b) => {
    const score = scoreBoat(b);
    return { b, score, w: Math.exp(score / T_SIM) };
  });
  const M = boats.length;
  const pos1 = Array(M).fill(0), pos2 = Array(M).fill(0), pos3 = Array(M).fill(0);
  const trif = new Map(); // "a-b-c"(艇番) -> 回数

  for (let s = 0; s < SIM_RUNS; s++) {
    const remain = seq(M);
    const order = [];
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (const i of remain) sum += boats[i].w;
      let r = Math.random() * sum, pick = remain[remain.length - 1];
      for (const i of remain) { r -= boats[i].w; if (r <= 0) { pick = i; break; } }
      order.push(pick);
      remain.splice(remain.indexOf(pick), 1);
    }
    pos1[order[0]]++; pos2[order[1]]++; pos3[order[2]]++;
    const key = boats[order[0]].b.racer_boat_number + "-" +
                boats[order[1]].b.racer_boat_number + "-" +
                boats[order[2]].b.racer_boat_number;
    trif.set(key, (trif.get(key) || 0) + 1);
  }

  boats.forEach((x, i) => {
    x.p1 = pos1[i] / SIM_RUNS * 100;        // 1着率
    x.p2 = pos2[i] / SIM_RUNS * 100;        // 2着率
    x.p3 = pos3[i] / SIM_RUNS * 100;        // 3着率
    x.in3 = (pos1[i] + pos2[i] + pos3[i]) / SIM_RUNS * 100; // 3着内率
  });
  boats.sort((a, b) => b.p1 - a.p1); // 1着率の高い順＝勝率順

  const combos = [...trif.entries()]
    .map(([key, c]) => ({ key, prob: c / SIM_RUNS * 100 }))
    .sort((a, b) => b.prob - a.prob);

  return { ranked: boats, combos, runs: SIM_RUNS };
}

// フォーメーション（1着/2着/3着の候補=ranked内インデックス集合）の
// シミュレーション的中率（％）を、出現した3連単の確率を合算して求める。
function formationHitRate(combos, ranked, s1, s2, s3) {
  const set1 = new Set(s1.map((i) => ranked[i].b.racer_boat_number));
  const set2 = new Set(s2.map((i) => ranked[i].b.racer_boat_number));
  const set3 = new Set(s3.map((i) => ranked[i].b.racer_boat_number));
  let hit = 0;
  for (const { key, prob } of combos) {
    const [a, b, c] = key.split("-").map(Number);
    if (set1.has(a) && set2.has(b) && set3.has(c)) hit += prob;
  }
  return hit;
}

// 候補フォーメーションを総当たりで評価し、点数あたりの的中率が
// 最も良い「効率フロンティア」を返す（=勝ちに最も近い買い目群）。
function buildFormations(combos, ranked) {
  const cands = [];
  for (const n1 of [1, 2]) for (const n2 of [2, 3, 4]) for (const n3 of [3, 4, 5]) {
    if (n2 < n1 || n3 < n2) continue;
    const s1 = seq(n1), s2 = seq(n2), s3 = seq(n3);
    const pts = countTrifecta(s1, s2, s3);
    const hit = formationHitRate(combos, ranked, s1, s2, s3);
    cands.push({ s1, s2, s3, pts, hit });
  }
  cands.sort((a, b) => a.pts - b.pts || b.hit - a.hit);
  const frontier = []; let best = -1;
  for (const c of cands) { if (c.hit > best + 0.5) { frontier.push(c); best = c.hit; } }
  return frontier;
}

// フロンティアから「絞り／標準／手広く」の3段階を点数順に等間隔で選ぶ。
function pickTiers(frontier) {
  const n = frontier.length;
  if (n <= 3) return frontier.slice();
  const idx = [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  return idx.map((i) => frontier[i]);
}

/* ----------------------------- 描画 ------------------------------------ */
const MARKS = ["◎", "○", "▲", "△", "×", ""];

function renderResult(race, pred) {
  const { ranked, combos, runs } = pred;
  const stadium = STADIUMS[race.race_stadium_number] || "場" + race.race_stadium_number;
  const grade = race.race_grade_number;
  const maxP1 = Math.max(ranked[0].p1, 1);

  let html = "";

  // レースヘッダー
  html += '<div class="race-head">';
  html += '<div class="rh-title">';
  if (GRADES[grade]) html += '<span class="badge grade-' + grade + '">' + GRADES[grade] + "</span>";
  html += stadium + " " + race.race_number + "R" + "</div>";
  html += '<div class="rh-sub">' + esc(race.race_title || "") +
          (race.race_subtitle ? " ／ " + esc(race.race_subtitle) : "") +
          " ・ " + (race.race_distance || "?") + "m" +
          " ・ 締切 " + (race.race_closed_at || "").slice(11, 16) + "</div>";
  html += '<div class="sim-tag">🎲 モンテカルロ ' + runs.toLocaleString() + "回 シミュレーション</div>";
  html += "</div>";

  // 印つき予想一覧（着順分布）
  html += '<div class="section-label">🎯 予想印・着順シミュレーション</div>';
  ranked.forEach((x, i) => { html += boatCard(x, i, maxP1); });

  // 3連単の出現上位（シミュレーション頻度）
  html += '<div class="section-label">📊 3連単 出現ランキング（上位8）</div>';
  html += renderTopCombos(combos, ranked);

  // 勝ちに最も近いフォーメーション
  html += '<div class="section-label">💴 3連単フォーメーション（的中率＝シミュレーション）</div>';
  html += renderBets(pred);

  resultEl.innerHTML = html;
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function boatCard(x, i, maxP1) {
  const b = x.b;
  const lane = b.racer_boat_number;
  const cls = CLASSES[b.racer_class_number] || "";
  const mark = MARKS[i] || "";
  const barW = (x.p1 / maxP1 * 100).toFixed(0);
  const fl = (b.racer_flying_count || 0) + (b.racer_late_count || 0);

  let h = '<div class="boat-card full">';
  h += '<div class="rank-mark">' + mark + "</div>";
  h += '<div class="lane-num lane-' + lane + '">' + lane + "</div>";
  h += '<div class="boat-info">';
  h += '<div class="boat-name">' + esc(b.racer_name || "") +
       '<span class="boat-class class-' + cls + '">' + cls + "</span></div>";
  h += '<div class="boat-meta">' +
       "全国 " + fmt(b.racer_national_top_2_percent) + "% ／ 当地 " + fmt(b.racer_local_top_2_percent) + "% ／ ST " +
       (b.racer_average_start_timing != null ? b.racer_average_start_timing.toFixed(2) : "-") +
       (fl ? " ／ F/L⚠" + fl : "") + "</div>";
  h += '<div class="score-bar"><div style="width:' + barW + '%"></div></div>';
  h += "</div>";
  h += '<div class="boat-prob"><span class="prob-val">' + x.p1.toFixed(1) + '%</span><span class="prob-label">1着率</span></div>';

  h += '<div class="boat-detail">';
  h += "<span>2着率: <b>" + x.p2.toFixed(1) + "%</b></span>";
  h += "<span>3着率: <b>" + x.p3.toFixed(1) + "%</b></span>";
  h += "<span>3着内率: <b>" + x.in3.toFixed(1) + "%</b></span>";
  h += "<span>モーター2連: <b>" + fmt(b.racer_assigned_motor_top_2_percent) + "%</b></span>";
  h += "</div>";
  h += "</div>";
  return h;
}

// 3連単の出現上位をシミュレーション確率つきで表示
function renderTopCombos(combos, ranked) {
  let h = '<div class="bet-box">';
  combos.slice(0, 8).forEach((c, idx) => {
    const [a, b, cc] = c.key.split("-").map(Number);
    h += '<div class="combo-row">';
    h += '<span class="combo-rank">' + (idx + 1) + "</span>";
    h += '<span class="fm-chip lane-' + a + '">' + a + "</span>";
    h += '<span class="combo-arrow">→</span><span class="fm-chip lane-' + b + '">' + b + "</span>";
    h += '<span class="combo-arrow">→</span><span class="fm-chip lane-' + cc + '">' + cc + "</span>";
    h += '<span class="combo-prob">' + c.prob.toFixed(1) + "%</span>";
    h += "</div>";
  });
  h += '<div class="bet-note">※ シミュレーションでこの並びが出た割合。1点目の本命候補です。</div>';
  h += "</div>";
  return h;
}

// 勝ちに最も近い3連単フォーメーションを、シミュレーションの的中率で提案する。
function renderBets(pred) {
  const { ranked, combos } = pred;
  const frontier = buildFormations(combos, ranked);
  const tiers = pickTiers(frontier);
  // 効率（的中率/点数）が最も良いものを「おすすめ」に
  let bestEff = tiers[0];
  for (const t of tiers) if (t.hit / t.pts > bestEff.hit / bestEff.pts) bestEff = t;

  const labels = ["絞り（少点数）", "標準", "手広く"];
  let h = "";
  tiers.forEach((t, i) => {
    const rec = (t === bestEff);
    h += formationBox(labels[i] || "フォーメーション", t, ranked, rec);
  });
  return h;
}

// フォーメーション1つを描画（シミュレーション的中率つき）
function formationBox(label, t, ranked, recommended) {
  let h = '<div class="bet-box' + (recommended ? " recommended" : "") + '">';
  h += '<div class="bet-type">3連単 ' + label +
       (recommended ? ' <span class="rec-tag">★勝ちに最も近い</span>' : "") + "</div>";
  h += fmRow("1着", t.s1, ranked);
  h += fmRow("2着", t.s2, ranked);
  h += fmRow("3着", t.s3, ranked);
  h += '<div class="fm-summary">的中率 <b class="hit">' + t.hit.toFixed(1) + "%</b>" +
       ' ／ ' + t.pts + "点 = <b>" + (t.pts * 100).toLocaleString() + "円</b>（100円/点）</div>";
  h += "</div>";
  return h;
}

function fmRow(label, set, ranked) {
  let h = '<div class="fm-row"><span class="fm-pos">' + label + '</span><span class="fm-chips">';
  for (const i of set) {
    const lane = ranked[i].b.racer_boat_number;
    h += '<span class="fm-chip lane-' + lane + '">' + (MARKS[i] || "") + lane + "</span>";
  }
  return h + "</span></div>";
}

// フォーメーションの有効点数（1着≠2着≠3着の順列組合せ数）
function countTrifecta(s1, s2, s3) {
  let n = 0;
  for (const a of s1) for (const b of s2) for (const c of s3)
    if (a !== b && b !== c && a !== c) n++;
  return n;
}

/* ----------------------------- ユーティリティ --------------------------- */
function fmt(v) { return (v == null) ? "-" : (Math.round(v * 100) / 100); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function setStatus(html, isError) {
  statusEl.innerHTML = html;
  statusEl.className = "status" + (isError ? " error" : "");
}

/* ----------------------------- イベント --------------------------------- */
venueSel.addEventListener("change", populateRaces);
predictBtn.addEventListener("click", () => {
  const list = byStadium.get(Number(venueSel.value)) || [];
  const race = list.find((r) => r.race_number === Number(raceSel.value));
  if (!race) return;
  renderResult(race, predict(race));
});

loadData();
