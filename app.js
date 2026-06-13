"use strict";

/* ===========================================================================
 * ボートレース予想アプリ
 * Boatrace Open API (https://boatraceopenapi.github.io/) の出走表データを
 * ブラウザから直接取得し、独自スコアリングで予想を算出する静的アプリ。
 * バックエンド不要・CORS対応済みなので GitHub Pages 等にそのまま置けます。
 * =========================================================================== */

const PROGRAMS_URL = "https://boatraceopenapi.github.io/programs/v2/today.json";
const PREVIEWS_URL = "https://boatraceopenapi.github.io/previews/v2/today.json";

// ビルド識別（最新ファイルを開いているか判別用）
const APP_VERSION = "2026-06-13 直前情報サーバー(Cloudflare)対応 (v10)";

// 天候番号 → 表示
const WEATHER = { 1: "☀️晴", 2: "☁️曇", 3: "🌧️雨", 4: "❄️雪", 5: "🌫️霧" };

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

// 直前情報（展示）の加点重み。preview がある時だけスコアに上乗せする。
const PRE_WEIGHTS = {
  exhibition: 16,  // 展示タイム（レース内で相対評価。速いほど加点）
  exhibitST:  6,   // 展示スタートタイミング（鋭いほど加点）
};

// 予想モデルの温度（小さいほど強い艇に評価が集中＝堅く出る）
const TEMP = 13;

const $ = (id) => document.getElementById(id);
const venueSel = $("venue");
const raceSel = $("race");
const predictBtn = $("predict");
const statusEl = $("status");
const resultEl = $("result");

let PROGRAMS = [];          // 全プログラム
let byStadium = new Map();  // stadium番号 -> [race,...]
let PREVIEWS = new Map();   // "stadium-race" -> 直前情報

const preKey = (stadium, raceNo) => stadium + "-" + raceNo;

/* ------------------- 直前情報サーバー（プロキシ）設定 ------------------- */
// ↓ デプロイした Cloudflare Worker のURLをここに焼き込むと、スマホでも設定なしで動く
const DEFAULT_PROXY_URL = "";
const PROXY_KEY = "boatrace_proxy_url";
let proxyUrlMem = "";

// URLハッシュ #proxy=... からの指定（ホーム画面ショートカット用）
function hashProxyUrl() {
  try {
    const v = new URLSearchParams((location.hash || "").replace(/^#/, "")).get("proxy");
    return v ? decodeURIComponent(v) : "";
  } catch { return ""; }
}

// 優先順位: ⚙️手入力(localStorage) → URLハッシュ → 埋め込みデフォルト
function getProxyUrl() {
  let saved = "";
  try { saved = localStorage.getItem(PROXY_KEY) || ""; } catch { saved = proxyUrlMem; }
  return (saved || proxyUrlMem || hashProxyUrl() || DEFAULT_PROXY_URL || "").trim();
}
function setProxyUrl(v) {
  proxyUrlMem = v || "";
  try { localStorage.setItem(PROXY_KEY, proxyUrlMem); } catch { /* file:// 等で不可でもメモリ保持 */ }
}

// プロキシJSON → アプリ内 preview 形式へ変換
function proxyToPreview(d, stadium, raceNo) {
  if (!d || !d.exhibition || !d.boats) return null;
  const boats = {};
  for (const k of Object.keys(d.boats)) {
    const b = d.boats[k];
    boats[String(b.boat || k)] = {
      racer_boat_number: b.boat || Number(k),
      racer_course_number: b.course,
      racer_exhibition_time: b.exhibition_time,
      racer_start_timing: b.start_timing,
      racer_tilt_adjustment: b.tilt,
      racer_weight: b.weight,
    };
  }
  const W = d.weather || {};
  const wmap = { "晴": 1, "曇り": 2, "曇": 2, "雨": 3, "雪": 4, "霧": 5 };
  return {
    race_stadium_number: stadium, race_number: raceNo, boats,
    race_wind: W.wind_speed != null ? Number(W.wind_speed) : null,
    race_wave: W.wave_height != null ? Number(W.wave_height) : null,
    race_temperature: W.air_temperature != null ? Number(W.air_temperature) : null,
    race_water_temperature: W.water_temperature != null ? Number(W.water_temperature) : null,
    race_weather_number: wmap[(W.weather_text || "").trim()] || null,
  };
}

// プロキシから締切前の直前情報を取得（未設定/失敗時は null）
async function fetchLivePreview(race) {
  const proxy = getProxyUrl();
  if (!proxy) return null;
  const hd = (race.race_date || "").replace(/-/g, "");
  const jcd = String(race.race_stadium_number).padStart(2, "0");
  const sep = proxy.includes("?") ? "&" : "?";
  const u = proxy + sep + "jcd=" + jcd + "&rno=" + race.race_number + "&hd=" + hd + "&_=" + Date.now();
  const res = await fetch(u, { cache: "no-store" });
  if (!res.ok) throw new Error("proxy HTTP " + res.status);
  const d = await res.json();
  return proxyToPreview(d, race.race_stadium_number, race.race_number);
}

/* ----------------------------- データ取得 ------------------------------ */
async function loadData() {
  setStatus('<div class="spinner"></div>本日の出走表・直前情報を取得中…');
  try {
    // 出走表（必須）と直前情報（任意）を並行取得。?_= でキャッシュ回避し常に最新を取る
    const bust = "?_=" + Date.now();
    const [progRes, prevRes] = await Promise.all([
      fetch(PROGRAMS_URL + bust, { cache: "no-store" }),
      fetch(PREVIEWS_URL + bust, { cache: "no-store" }).catch(() => null),
    ]);
    if (!progRes.ok) throw new Error("HTTP " + progRes.status);
    const json = await progRes.json();
    PROGRAMS = Array.isArray(json.programs) ? json.programs : [];
    if (!PROGRAMS.length) {
      setStatus("本日のレースデータが見つかりませんでした。開催がない可能性があります。", true);
      return;
    }
    // 直前情報（取得できた分だけ）
    PREVIEWS = new Map();
    if (prevRes && prevRes.ok) {
      try {
        const pj = await prevRes.json();
        for (const p of (pj.previews || []))
          PREVIEWS.set(preKey(p.race_stadium_number, p.race_number), p);
      } catch { /* 直前情報なしでも続行 */ }
    }
    groupByStadium();
    populateVenues();
    // 取得サマリ：展示タイムが入っている（展示済み）レース数を表示
    const withEx = [...PREVIEWS.values()].filter((p) =>
      p && p.boats && Object.values(p.boats).some((b) => (b && b.racer_exhibition_time) > 0)).length;
    setStatus("✅ 本日 " + PROGRAMS.length + "R 取得。🟢展示反映済 " + withEx + "R（残りは展示前）。会場とレースを選んで予想！");
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
// pv（直前情報）があれば、枠番ではなく「実際の進入コース」で有利度を評価する。
function scoreBoat(b, pv) {
  const course = (pv && pv.racer_course_number) || b.racer_boat_number;
  const pct = (v) => clamp(v || 0, 0, 100);          // %系（0-100）
  const rate = (v) => clamp((v || 0) / 8 * 100, 0, 100); // 勝率系（概ね0-8）

  const courseScore = (COURSE_WIN_RATE[course] || 0) / 55 * 100;
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

// Claude流の各艇分析。スコアに加え、コース取り（戦法）と
// データから読み取れる所見（コメント材料）を生成する。pv は直前情報。
function analyzeBoat(b, pv) {
  const score = scoreBoat(b, pv);
  const tags = [];
  const course = (pv && pv.racer_course_number) || b.racer_boat_number;

  const courseRole = {
    1: "イン逃げの軸",
    2: "差し・まくりの2番手",
    3: "3コースから差し／まくり",
    4: "カドまくりの一発",
    5: "外枠から展開待ち",
    6: "大外で展開待ち",
  }[course] || "";

  // 直前：枠と進入コースが違えば前付け/隊形変化として明記
  if (pv && pv.racer_course_number && pv.racer_course_number !== b.racer_boat_number)
    tags.push("⚡" + b.racer_boat_number + "枠→" + pv.racer_course_number + "コース進入");

  if (b.racer_class_number === 1) tags.push("A1級の実力者");
  else if (b.racer_class_number === 4) tags.push("B2級で格下");

  const n2 = b.racer_national_top_2_percent || 0;
  if (n2 >= 45) tags.push("全国2連率" + fmt(n2) + "%と一線級");
  else if (n2 >= 35) tags.push("安定した近況");
  else if (n2 < 25 && n2 > 0) tags.push("近況は振るわず");

  const l2 = b.racer_local_top_2_percent || 0;
  if (l2 - n2 >= 5) tags.push("当地巧者（当地2連率" + fmt(l2) + "%）");

  const st = b.racer_average_start_timing;
  if (st != null && st <= 0.14) tags.push("ST" + st.toFixed(2) + "と鋭い");
  else if (st != null && st >= 0.19) tags.push("STやや甘め");

  const m2 = b.racer_assigned_motor_top_2_percent || 0;
  if (m2 >= 42) tags.push("好機関（モーター2連率" + fmt(m2) + "%）");
  else if (m2 <= 28 && m2 > 0) tags.push("モーター非力");

  const f = b.racer_flying_count || 0;
  if (f >= 1) tags.push("F" + f + "持ちで慎重");

  // 直前：チルト・展示ST
  if (pv) {
    const tilt = pv.racer_tilt_adjustment;
    if (tilt != null && tilt >= 0.5) tags.push("チルト" + tilt + "で伸び勝負");
    const est = pv.racer_start_timing;
    if (est != null && est <= 0.05) tags.push("展示ST" + est.toFixed(2) + "と好スタート");
  }

  return { b, pv, score, course, courseRole, tags, w: Math.exp(score / TEMP) };
}

// Claudeの分析予想。乱数を使わず、Plackett-Luce の閉形式で
// 各艇の1着/2着/3着確率と3連単(1着-2着-3着)の確率を厳密に計算する。
// preview があれば直前情報（進入・展示）を反映する。
function predict(race, preview) {
  // 展示が実施済みか（展示タイムが入っているか）を判定。
  // 発走前で展示前だと preview はあっても全艇 0.00 のため、その場合は直前情報を使わない。
  const hasExhibition = !!(preview && preview.boats &&
    Object.values(preview.boats).some((b) => (b && b.racer_exhibition_time) > 0));
  const usePv = hasExhibition ? preview : null;

  const items = race.boats.map((b) => {
    const pv = usePv && usePv.boats ? usePv.boats[String(b.racer_boat_number)] : null;
    return analyzeBoat(b, pv);
  });
  const n = items.length;

  // 直前：展示タイムをレース内で相対評価して加点（速いほど高評価）
  const exTimes = items.map((x) => x.pv && x.pv.racer_exhibition_time).filter((t) => t > 0);
  if (exTimes.length >= 2) {
    const min = Math.min(...exTimes), max = Math.max(...exTimes);
    items.forEach((x) => {
      const t = x.pv && x.pv.racer_exhibition_time;
      if (t != null && max > min) {
        x.exScore = (max - t) / (max - min) * 100;     // 0-100
        x.score += PRE_WEIGHTS.exhibition * (x.exScore / 100);
        // 展示タイム上位はタグでも明示
      }
      // 展示STの鋭さも軽く加点
      const est = x.pv && x.pv.racer_start_timing;
      if (est != null) {
        const stScore = clamp((0.20 - est) / (0.20 - (-0.05)) * 100, 0, 100);
        x.score += PRE_WEIGHTS.exhibitST * (stScore / 100);
      }
      x.w = Math.exp(x.score / TEMP); // 加点後に強さを再計算
    });
    // 展示最速にタグ付け
    const fastest = items.reduce((a, x) =>
      (x.pv && x.pv.racer_exhibition_time != null &&
       (!a || x.pv.racer_exhibition_time < a.pv.racer_exhibition_time)) ? x : a, null);
    if (fastest) fastest.tags.unshift("展示タイム最速" + fastest.pv.racer_exhibition_time.toFixed(2));
  }

  const W = items.reduce((s, x) => s + x.w, 0);

  const p2 = Array(n).fill(0), p3 = Array(n).fill(0);
  const combos = [];
  items.forEach((x, i) => { x.p1 = x.w / W * 100; });

  for (let i = 0; i < n; i++) {
    const wi = items[i].w, W1 = W - wi;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const wj = items[j].w, W2 = W1 - wj;
      const pij = (wi / W) * (wj / W1);   // P(1着=i, 2着=j)
      p2[j] += pij;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const pijk = pij * (items[k].w / W2); // P(1着=i,2着=j,3着=k)
        p3[k] += pijk;
        combos.push({
          key: items[i].b.racer_boat_number + "-" +
               items[j].b.racer_boat_number + "-" +
               items[k].b.racer_boat_number,
          prob: pijk * 100,
        });
      }
    }
  }
  items.forEach((x, i) => {
    x.p2 = p2[i] * 100;
    x.p3 = p3[i] * 100;
    x.in3 = x.p1 + x.p2 + x.p3;
  });

  combos.sort((a, b) => b.prob - a.prob);
  items.sort((a, b) => b.p1 - a.p1); // 1着確率の高い順＝予想印順

  // 気象データは展示前でも取得できることが多い
  const hasWeather = !!(preview && (preview.race_wind != null || preview.race_weather_number != null));
  return {
    ranked: items, combos, hasExhibition, hasWeather, preview,
    comment: raceComment(items, hasExhibition),
  };
}

// Claudeのレース総評を文章で生成
function raceComment(ranked, hasPreview) {
  const nm = (x) => x.b.racer_boat_number + "号艇" + (x.b.racer_name ? "・" + x.b.racer_name : "");
  const o = ranked[0], t = ranked[1], s = ranked[2], a = ranked[3];
  let txt = hasPreview ? "【直前情報（展示）を反映】" : "【出走表のみ・展示前】";
  txt += "本命は" + nm(o) + "。" + o.courseRole +
         "で1着率" + o.p1.toFixed(0) + "%、最も信頼できる。";
  if (o.tags[0]) txt += "（" + o.tags[0] + "）";
  txt += "対抗は" + nm(t) + "、" + (t.tags[0] || t.courseRole) + "。";
  txt += "3着付けに" + nm(s) + "を加えたい。";
  if (a && a.p1 >= 8) txt += "波乱含みなら" + nm(a) + "の一発にも警戒。";
  // 堅さ/荒れの総括
  if (o.p1 >= 55) txt += " 全体に本命が抜けており、堅く狙えるレース。";
  else if (o.p1 < 35) txt += " 上位が拮抗しており、頭が割れやすい難解なレース。";
  return txt;
}

// フォーメーション（1着/2着/3着の候補=ranked内インデックス集合）の
// 的中率（％）＝フォーメーションに含まれる3連単の確率を合算した値。
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
  const { ranked, combos, comment, hasExhibition, hasWeather, preview } = pred;
  const stadium = STADIUMS[race.race_stadium_number] || "場" + race.race_stadium_number;
  const grade = race.race_grade_number;
  const maxP1 = Math.max(ranked[0].p1, 1);

  let html = "";

  // レースヘッダー
  html += '<div class="race-head">';
  html += '<div class="rh-title">';
  if (GRADES[grade]) html += '<span class="badge grade-' + grade + '">' + GRADES[grade] + "</span>";
  html += stadium + " " + race.race_number + "R";
  html += hasExhibition
    ? '<span class="pre-badge on">展示反映済</span>'
    : '<span class="pre-badge off">展示前（出走表のみ）</span>';
  html += "</div>";
  html += '<div class="rh-sub">' + esc(race.race_title || "") +
          (race.race_subtitle ? " ／ " + esc(race.race_subtitle) : "") +
          " ・ " + (race.race_distance || "?") + "m" +
          " ・ 締切 " + (race.race_closed_at || "").slice(11, 16) + "</div>";
  // 気象コンディション（展示前でも表示）
  if (hasWeather) {
    const w = WEATHER[preview.race_weather_number] || "";
    html += '<div class="cond">' +
      (w ? '<span>' + w + "</span>" : "") +
      '<span>🌬️風 ' + (preview.race_wind != null ? preview.race_wind + "m" : "-") + "</span>" +
      '<span>🌊波 ' + (preview.race_wave != null ? preview.race_wave + "cm" : "-") + "</span>" +
      '<span>🌡️気温 ' + (preview.race_temperature != null ? preview.race_temperature + "℃" : "-") + "</span>" +
      '<span>💧水温 ' + (preview.race_water_temperature != null ? preview.race_water_temperature + "℃" : "-") + "</span>" +
      "</div>";
  }
  html += "</div>";

  // 展示前のお知らせ
  if (!hasExhibition) {
    const hasProxy = getProxyUrl();
    html += '<div class="pre-note">⏳ このレースはまだ展示（直前情報）が反映されていません。' +
      (hasProxy
        ? "公式にまだ展示が出ていないか、取得に失敗した可能性があります。発走が近づいたら再度「予想する」を押してください。"
        : "⚙️直前情報サーバーを設定すると、締切前でも公式サイトから展示を自動取得できます（worker/README.md 参照）。") +
      "</div>";
  }

  // Claudeの総評
  html += '<div class="claude-comment"><div class="cc-head">🧠 Claudeの予想</div>' +
          '<div class="cc-body">' + esc(comment) + "</div></div>";

  // 印つき予想一覧（各艇分析）
  html += '<div class="section-label">🎯 予想印・各艇分析</div>';
  ranked.forEach((x, i) => { html += boatCard(x, i, maxP1); });

  // 3連単の確率上位
  html += '<div class="section-label">📊 3連単 確率上位（Claude分析）</div>';
  html += renderTopCombos(combos, ranked);

  // 勝ちに最も近いフォーメーション
  html += '<div class="section-label">💴 3連単フォーメーション（的中率＝分析確率）</div>';
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
  if (x.pv && x.pv.racer_exhibition_time > 0) {
    h += '<span class="pre">進入: <b>' + (x.pv.racer_course_number || lane) + "コース</b></span>";
    h += '<span class="pre">展示T: <b>' + x.pv.racer_exhibition_time.toFixed(2) + "</b></span>";
    h += '<span class="pre">展示ST: <b>' + (x.pv.racer_start_timing != null ? x.pv.racer_start_timing.toFixed(2) : "-") + "</b></span>";
    h += '<span class="pre">チルト: <b>' + (x.pv.racer_tilt_adjustment != null ? x.pv.racer_tilt_adjustment : "-") + "</b></span>";
  }
  h += "</div>";
  // Claudeの所見
  const cmt = (x.courseRole ? x.courseRole : "") + (x.tags.length ? "。" + x.tags.join("・") : "");
  if (cmt) h += '<div class="boat-cmt">💬 ' + esc(cmt) + "</div>";
  h += "</div>";
  return h;
}

// 3連単の確率上位を表示
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
  h += '<div class="bet-note">※ Claude分析によるこの並びの出現確率。1点目の本命候補です。</div>';
  h += "</div>";
  return h;
}

// 勝ちに最も近い3連単フォーメーションを、分析確率による的中率で提案する。
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

// フォーメーション1つを描画（分析確率による的中率つき）
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
let currentRaceKey = null; // 表示中レース（更新時の再描画用）

venueSel.addEventListener("change", populateRaces);

async function runPrediction() {
  const list = byStadium.get(Number(venueSel.value)) || [];
  const race = list.find((r) => r.race_number === Number(raceSel.value));
  if (!race) return;
  currentRaceKey = preKey(race.race_stadium_number, race.race_number);
  let preview = PREVIEWS.get(currentRaceKey); // オープンAPI（フォールバック）

  // 直前情報サーバーが設定されていれば、締切前の展示を公式から取得
  if (getProxyUrl()) {
    const prevStatus = statusEl.innerHTML;
    setStatus('<div class="spinner"></div>直前情報サーバーから展示データを取得中…');
    try {
      const live = await fetchLivePreview(race);
      if (live && live.boats) preview = live;
    } catch (e) {
      setStatus("⚠️ 直前情報サーバーに接続できませんでした（出走表ベースで予想します）。<br><small>" + e.message + "</small>", true);
      setTimeout(() => { if (statusEl.textContent.includes("直前情報サーバーに接続")) setStatus(""); }, 4000);
    }
    if (statusEl.querySelector(".spinner")) setStatus("");
  }

  renderResult(race, predict(race, preview));
}

predictBtn.addEventListener("click", () => { runPrediction(); });

// 🔄 データ再取得 → 表示中レースを最新データで再描画
const refreshBtn = $("refresh");
if (refreshBtn) refreshBtn.addEventListener("click", () => {
  const v = venueSel.value, r = raceSel.value;
  refreshBtn.disabled = true;
  loadData().then(() => {
    if (v) { venueSel.value = v; populateRaces(); if (r) raceSel.value = r; }
    if (!resultEl.hidden && raceSel.value) runPrediction(); // 結果表示中なら最新で更新
    refreshBtn.disabled = false;
  });
});

// 直前情報サーバーURL入力（localStorage に保存）
const proxyInput = $("proxyUrl");
if (proxyInput) {
  proxyInput.value = getProxyUrl();
  proxyInput.addEventListener("change", () => setProxyUrl(proxyInput.value));
  proxyInput.addEventListener("blur", () => setProxyUrl(proxyInput.value));
}

// バージョン表示
const verEl = $("version");
if (verEl) verEl.textContent = "ビルド: " + APP_VERSION;

loadData();
