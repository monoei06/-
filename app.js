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

// 予想モデルの重み（合計1.0）
const WEIGHTS = {
  course: 0.30,   // コース（進入）有利度
  nat2:   0.22,   // 全国2連対率
  nat1:   0.12,   // 全国勝率
  local2: 0.10,   // 当地2連対率
  start:  0.10,   // 平均スタートタイミング
  motor:  0.10,   // モーター2連対率
  cls:    0.06,   // 級別
};

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

// 各艇のスコア（0-100目安）を算出
function scoreBoat(b) {
  const lane = b.racer_boat_number;

  // 各指標を 0-100 に正規化
  const courseScore = (COURSE_WIN_RATE[lane] || 0) / 55 * 100;
  const nat2 = clamp(b.racer_national_top_2_percent || 0, 0, 100);
  const nat1 = clamp((b.racer_national_top_1_percent || 0) / 8 * 100, 0, 100); // 勝率は概ね0-8
  const local2 = clamp(b.racer_local_top_2_percent || 0, 0, 100);
  // 平均ST: 0.10秒=満点, 0.25秒=0点（低いほど良い）
  const st = b.racer_average_start_timing;
  const startScore = (st == null) ? 50 : clamp((0.25 - st) / (0.25 - 0.10) * 100, 0, 100);
  const motor2 = clamp(b.racer_assigned_motor_top_2_percent || 0, 0, 100);
  const clsScore = { 1: 100, 2: 75, 3: 50, 4: 25 }[b.racer_class_number] || 50;

  let score =
    WEIGHTS.course * courseScore +
    WEIGHTS.nat2   * nat2 +
    WEIGHTS.nat1   * nat1 +
    WEIGHTS.local2 * local2 +
    WEIGHTS.start  * startScore +
    WEIGHTS.motor  * motor2 +
    WEIGHTS.cls    * clsScore;

  // フライング・出遅れ減点（事故率・信頼性の低下）
  const fl = (b.racer_flying_count || 0) + (b.racer_late_count || 0);
  score -= fl * 8;

  return Math.max(score, 1);
}

function predict(race) {
  const boats = race.boats.map((b) => ({ b, score: scoreBoat(b) }));

  // softmax で勝率（％）に変換。温度で差を強調。
  const T = 18;
  const exps = boats.map((x) => Math.exp(x.score / T));
  const sum = exps.reduce((a, c) => a + c, 0);
  boats.forEach((x, i) => { x.prob = exps[i] / sum * 100; });

  // スコア降順
  boats.sort((a, b) => b.score - a.score);
  return boats;
}

/* ----------------------------- 描画 ------------------------------------ */
const MARKS = ["◎", "○", "▲", "△", "×", ""];

function renderResult(race, ranked) {
  const stadium = STADIUMS[race.race_stadium_number] || "場" + race.race_stadium_number;
  const grade = race.race_grade_number;
  const maxScore = ranked[0].score;

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
  html += "</div>";

  // 印つき予想一覧
  html += '<div class="section-label">🎯 予想印・勝率</div>';
  ranked.forEach((x, i) => {
    html += boatCard(x, i, maxScore, true);
  });

  // 買い目提案
  html += '<div class="section-label">💴 おすすめ買い目</div>';
  html += renderBets(ranked);

  resultEl.innerHTML = html;
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function boatCard(x, i, maxScore, detail) {
  const b = x.b;
  const lane = b.racer_boat_number;
  const cls = CLASSES[b.racer_class_number] || "";
  const mark = MARKS[i] || "";
  const barW = (x.score / maxScore * 100).toFixed(0);

  let h = '<div class="boat-card' + (detail ? " full" : "") + '">';
  h += '<div class="rank-mark">' + mark + "</div>";
  h += '<div class="lane-num lane-' + lane + '">' + lane + "</div>";
  h += '<div class="boat-info">';
  h += '<div class="boat-name">' + esc(b.racer_name || "") +
       '<span class="boat-class class-' + cls + '">' + cls + "</span></div>";
  h += '<div class="boat-meta">' +
       "全国 " + fmt(b.racer_national_top_2_percent) + "% ／ 当地 " + fmt(b.racer_local_top_2_percent) + "% ／ ST " +
       (b.racer_average_start_timing != null ? b.racer_average_start_timing.toFixed(2) : "-") +
       "</div>";
  h += '<div class="score-bar"><div style="width:' + barW + '%"></div></div>';
  h += "</div>";
  h += '<div class="boat-prob"><span class="prob-val">' + x.prob.toFixed(0) + '%</span><span class="prob-label">勝率</span></div>';

  if (detail) {
    const fl = (b.racer_flying_count || 0) + (b.racer_late_count || 0);
    h += '<div class="boat-detail">';
    h += "<span>勝率: <b>" + fmt(b.racer_national_top_1_percent) + "</b></span>";
    h += "<span>3連率: <b>" + fmt(b.racer_national_top_3_percent) + "%</b></span>";
    h += "<span>モーター2連: <b>" + fmt(b.racer_assigned_motor_top_2_percent) + "%</b></span>";
    h += "<span>F/L: <b>" + (fl ? "⚠ " + fl : "0") + "</b></span>";
    h += "</div>";
  }
  h += "</div>";
  return h;
}

function renderBets(ranked) {
  const n = ranked.map((x) => x.b.racer_boat_number); // スコア順の艇番
  const [a, bb, c, d] = n;

  let h = "";

  // 本命 3連単（◎→○▲→○▲△）
  h += '<div class="bet-box">';
  h += '<div class="bet-type">3連単・本命（◎1着固定）</div>';
  h += combo(a, "-", bb, "-", c);
  h += combo(a, "-", c, "-", bb);
  h += '<div class="bet-note">◎の1着を信頼し、相手を○▲で。手堅く狙う2点。</div>';
  h += "</div>";

  // 3連単・抑え（◎○の2艇軸ながし）
  h += '<div class="bet-box">';
  h += '<div class="bet-type">3連単・抑え（◎○ 2艇軸ながし）</div>';
  h += combo(a, "-", bb, "-", c) + combo(a, "-", bb, "-", d);
  h += combo(bb, "-", a, "-", c) + combo(bb, "-", a, "-", d);
  h += '<div class="bet-note">◎と○の1-2着入れ替え＋3着に▲△。波乱もケアする4点。</div>';
  h += "</div>";

  // 3連複ボックス（上位3艇）
  h += '<div class="bet-box">';
  h += '<div class="bet-type">3連複・手堅く（上位3艇BOX）</div>';
  h += combo(a, "=", bb, "=", c);
  h += '<div class="bet-note">' + a + "・" + bb + "・" + c + " の3艇が3着内に入れば的中（1点）。</div>";
  h += "</div>";

  // 2連単・本命
  h += '<div class="bet-box">';
  h += '<div class="bet-type">2連単・シンプル</div>';
  h += combo(a, "-", bb) + combo(a, "-", c);
  h += '<div class="bet-note">◎の頭から○▲へ。当てやすさ重視。</div>';
  h += "</div>";

  return h;
}

function combo(...parts) {
  let s = '<span class="bet-combo">';
  for (const p of parts) {
    if (p === "-" || p === "=") s += '<span style="color:var(--muted)"> ' + (p === "=" ? "=" : "→") + " </span>";
    else s += '<span class="combo-num">' + p + "</span>";
  }
  return s + "</span>";
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
