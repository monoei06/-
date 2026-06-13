/**
 * 中央競馬(JRA) データプロキシ (Cloudflare Workers)
 * ---------------------------------------------------------------------------
 * netkeiba の公開ページ／オッズAPIを取得・整形し、CORS 許可つきの UTF-8 JSON で
 * 返す小さなプロキシです。これにより、スマホ上の静的HTMLアプリから
 * 「本日の全開催・全レース」と「各レースの単勝/複勝オッズ・人気・馬名」を取得できます。
 *
 * エンドポイント:
 *   GET /?date=YYYYMMDD        本日(または指定日)の開催・レース一覧
 *       例: /?date=20260613
 *       省略時は日本時間の本日。
 *   GET /?race_id=NNNNNNNNNNNN 1レースの詳細(出走馬・単勝/複勝オッズ・人気)
 *       例: /?race_id=202605030311
 *
 * デプロイ手順は worker/KEIBA-README.md を参照（Cloudflare 無料枠で動きます）。
 *
 * 注意: netkeiba の HTML/JSON 構造が変わると解析が壊れる可能性があります。
 *       公開データのみを、常識的なアクセス頻度（予想ボタンを押した時だけ）で取得します。
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// 場コード(race_id の 5-6 桁目) → 競馬場名
const PLACE = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
  "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const raceId = (url.searchParams.get("race_id") || "").trim();
    const date = (url.searchParams.get("date") || "").replace(/\D/g, "") || todayJST();

    try {
      if (raceId) {
        if (!/^\d{12}$/.test(raceId)) return json({ error: "race_id は12桁です" }, 400);
        return json(await getRace(raceId), 200, 20);
      }
      return json(await getDay(date), 200, 60);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },
};

/* ----------------------------- 一覧(本日の開催) ------------------------------ */
async function getDay(date) {
  const target =
    "https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=" + date;
  const html = await fetchText(target, "utf-8");

  // 開催見出し（"3回 東京 3日目" 等）の位置を取得して、各レースを最寄りの見出しに割り当てる
  const heads = [];
  const hre = /RaceList_DataTitle[^>]*>([\s\S]*?)<\/p>/g;
  let hm;
  while ((hm = hre.exec(html))) heads.push({ idx: hm.index, text: stripTags(hm[1]) });

  const races = [];
  const ire =
    /RaceList_DataItem[\s\S]*?race_id=(\d{12})[\s\S]*?ItemTitle">([^<]*)<\/span>[\s\S]*?Itemtime">([^<]*)<\/span>\s*<span class="RaceList_ItemLong[^"]*">([^<]*)<\/span>\s*<span class="RaceList_Itemnumber">([^<]*)<\/span>/g;
  let im;
  while ((im = ire.exec(html))) {
    const race_id = im[1];
    const pp = race_id.slice(4, 6);
    let head = "";
    for (const h of heads) { if (h.idx < im.index) head = h.text; else break; }
    races.push({
      race_id,
      place_code: pp,
      place: PLACE[pp] || ("場" + pp),
      meeting: head,                      // 例: "3回 東京 3日目"
      race_no: Number(race_id.slice(10, 12)),
      name: decodeEnt(im[2]).trim(),
      post_time: im[3].trim(),
      course: decodeEnt(im[4]).trim(),    // 例: "ダ1600m" / "芝2000m"
      head_count: parseInt(im[5], 10) || null,
    });
  }

  // 開催場ごとにまとめる
  const meetings = new Map();
  for (const r of races) {
    if (!meetings.has(r.place_code)) {
      meetings.set(r.place_code, {
        place_code: r.place_code, place: r.place, meeting: r.meeting, races: [],
      });
    }
    meetings.get(r.place_code).races.push(r);
  }
  for (const m of meetings.values()) m.races.sort((a, b) => a.race_no - b.race_no);

  return {
    date,
    meetings: [...meetings.values()].sort((a, b) => a.place_code.localeCompare(b.place_code)),
    race_count: races.length,
    source: "netkeiba race_list_sub",
  };
}

/* ----------------------------- 詳細(1レース) ------------------------------ */
async function getRace(raceId) {
  const base = "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=" + raceId;
  const ref = { "Referer": "https://race.netkeiba.com/odds/index.html?race_id=" + raceId };
  const shutubaURL = "https://race.netkeiba.com/race/shutuba.html?race_id=" + raceId;
  const pastURL = "https://race.netkeiba.com/race/shutuba_past.html?race_id=" + raceId;

  // 単複(1)・馬連(4)・ワイド(5)・3連複(7)・3連単(8)・出走表・馬柱(近走) を並行取得
  const [o1, o4, o5, o7, o8, shutuba, spast] = await Promise.all([
    fetchText(base + "&type=1&action=update", "utf-8", ref),
    fetchText(base + "&type=4&action=update", "utf-8", ref).catch(() => ""),
    fetchText(base + "&type=5&action=update", "utf-8", ref).catch(() => ""),
    fetchText(base + "&type=7&action=update", "utf-8", ref).catch(() => ""),
    fetchText(base + "&type=8&action=update", "utf-8", ref).catch(() => ""),
    fetchText(shutubaURL, "euc-jp").catch(() => ""),
    fetchText(pastURL, "euc-jp").catch(() => ""),
  ]);
  const pastMap = parsePast(spast);

  // 単勝/複勝オッズと状態
  let win = {}, place = {}, official = "", status = "";
  try {
    const oj = JSON.parse(o1);
    const od = oj && oj.data && oj.data.odds ? oj.data.odds : {};
    win = od["1"] || {};
    place = od["2"] || {};
    official = (oj && oj.data && oj.data.official_datetime) || "";
    status = (oj && oj.status) || "";
  } catch { /* オッズ未発表でも続行 */ }

  // 各馬券種オッズプール（期待値計算用）
  const pools = {
    umaren: poolMap(o4, "4", false),
    wide: poolMap(o5, "5", true),
    trio: poolMap(o7, "7", false),
    trifecta: poolMap(o8, "8", false),
  };

  const meta = parseShutuba(shutuba);
  const head = parseRaceHead(shutuba);

  const nums = new Set([...Object.keys(win), ...Object.keys(meta)].map((k) => String(parseInt(k, 10))));
  const horses = [];
  for (const ns of nums) {
    const pad = ns.padStart(2, "0");
    const w = win[pad] || win[ns];
    const p = place[pad] || place[ns];
    const m = meta[ns] || {};
    horses.push({
      num: Number(ns),
      waku: m.waku != null ? m.waku : null,
      name: m.name || ("馬" + ns),
      jockey: m.jockey || "",
      sexage: m.sexage || "",
      weight_carry: m.weight_carry != null ? m.weight_carry : null,
      weight: m.weight != null ? m.weight : null,
      weight_diff: m.weight_diff != null ? m.weight_diff : null,
      win_odds: w ? num(w[0]) : null,
      place_min: p ? num(p[0]) : null,
      place_max: p ? num(p[1]) : null,
      popularity: w ? (parseInt(w[2], 10) || null) : (p ? parseInt(p[2], 10) || null : null),
      past: pastMap[ns] || [],
    });
  }
  horses.sort((a, b) => a.num - b.num);

  const pp = raceId.slice(4, 6);
  return {
    race_id: raceId,
    place_code: pp,
    place: PLACE[pp] || ("場" + pp),
    race_no: Number(raceId.slice(10, 12)),
    name: head.name || "",
    course: head.course || "",
    surface: head.surface || "",
    distance: head.distance || null,
    direction: head.direction || "",
    weather: head.weather || "",
    track_condition: head.track_condition || "",
    post_time: head.post_time || "",
    official_datetime: official,
    odds_status: status,
    has_odds: horses.some((h) => h.win_odds > 0),
    pools,
    horses,
    source: "netkeiba odds API(1/4/5/7/8) + shutuba",
  };
}

// オッズプールJSON → { comboKey: odds }（range=true なら [min,max]）
function poolMap(text, key, isRange) {
  const out = {};
  if (!text) return out;
  try {
    const oj = JSON.parse(text);
    const od = oj && oj.data && oj.data.odds ? oj.data.odds[key] : null;
    if (!od) return out;
    for (const k in od) {
      const v = od[k];
      out[k] = isRange ? [num(v[0]), num(v[1])] : num(v[0]);
    }
  } catch { /* プール未発売でも続行 */ }
  return out;
}

// 出走表HTML(EUC-JP→UTF-8済)を行ごとに分解して 馬番→各種フィールド
function parseShutuba(html) {
  const out = {};
  if (!html) return out;
  const rows = html.split(/<tr class="HorseList/);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const um = r.match(/<td class="Umaban\d+[^"]*">\s*(\d+)\s*</);
    if (!um) continue;
    const n = String(parseInt(um[1], 10));
    const waku = r.match(/Waku(\d+)/);
    const nm = r.match(/<span class="HorseName"><a[^>]*title="([^"]+)"/);
    const ba = r.match(/<td class="Barei[^"]*">([^<]*)</);
    const kin = r.match(/<td class="Txt_C">([\d.]+)<\/td>/);
    const jk = r.match(/<td class="Jockey">\s*<a[^>]*>\s*([^<]+?)\s*</);
    const wt = r.match(/<td class="Weight">\s*(\d+)?\s*(?:<small>\(([-+]?\d+)\)<\/small>)?/);
    out[n] = {
      waku: waku ? Number(waku[1]) : null,
      name: nm ? decodeEnt(nm[1]).trim() : ("馬" + n),
      sexage: ba ? decodeEnt(ba[1]).trim() : "",
      weight_carry: kin ? num(kin[1]) : null,
      jockey: jk ? decodeEnt(jk[1]).trim() : "",
      weight: wt && wt[1] ? num(wt[1]) : null,
      weight_diff: wt && wt[2] != null ? num(wt[2]) : null,
    };
  }
  return out;
}

// 馬柱(shutuba_past)から 馬番→近走配列（最大5走）。着順は非掲載のため時計・上がり等を抽出。
function parsePast(html) {
  const out = {};
  if (!html) return out;
  const rows = html.split(/<tr class="HorseList/);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const um = r.match(/<td class="Waku">\s*(\d+)\s*<\/td>/);
    if (!um) continue;
    const n = String(parseInt(um[1], 10));
    const arr = [];
    const cells = r.match(/<td class="Past"[^>]*>[\s\S]*?<\/td>/g) || [];
    for (const c of cells) {
      const d05 = pick(c, /<div class="Data05">([\s\S]*?)<\/div>/);
      if (!d05) continue;
      const t05 = stripTags(d05).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const cm = t05.match(/(芝|ダ|障)(\d+)\s+(\d):(\d{2})\.(\d)\s*(\S)?/);
      if (!cm) continue;
      const d01 = stripTags(pick(c, /<div class="Data01">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const klass = stripTags(pick(c, /<div class="Data02">([\s\S]*?)<\/div>/)).replace(/\s+/g, " ").trim();
      const d03 = stripTags(pick(c, /<div class="Data03">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const d06 = stripTags(pick(c, /<div class="Data06">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const d07 = stripTags(pick(c, /<div class="Data07">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const dm = d01.match(/([\d.]+)\s+(\S+)/);
      const fld = d03.match(/(\d+)頭/);
      const pop = d03.match(/(\d+)人/);
      const ag = d06.match(/\((\d{2}\.\d)\)/);
      const bw = d06.match(/(\d{3})\(([-+]?\d+)\)/);
      const mg = d07.match(/\((-?[\d.]+)\)/);
      arr.push({
        ymd: dm ? dm[1] : "", place: dm ? dm[2] : "", klass,
        surface: cm[1], dist: Number(cm[2]),
        sec: Number(cm[3]) * 60 + Number(cm[4]) + Number(cm[5]) / 10,
        going: cm[6] || "", field: fld ? Number(fld[1]) : null, pop: pop ? Number(pop[1]) : null,
        agari: ag ? Number(ag[1]) : null, body: bw ? Number(bw[1]) : null, bdiff: bw ? Number(bw[2]) : null,
        margin: mg ? Number(mg[1]) : null,
      });
      if (arr.length >= 5) break;
    }
    if (arr.length) out[n] = arr;
  }
  return out;
}

// 出走表HTMLからレース名・コース・馬場・天候など
function parseRaceHead(html) {
  if (!html) return {};
  const name = pick(html, /RaceName[^>]*>\s*([^<]+?)\s*</) || pick(html, /<title>([^|<]+)/);
  const data = pick(html, /<div class="RaceData01">([\s\S]*?)<\/div>/);
  let course = "", post_time = "", surface = "", distance = null, direction = "", weather = "", track = "";
  if (data) {
    const t = stripTags(data).replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const cm = t.match(/(芝|ダ|障)[^\d]*(\d+)m/);
    if (cm) { surface = cm[1]; distance = Number(cm[2]); course = cm[1] + cm[2] + "m"; }
    const dm = t.match(/[(（](左|右|直)/); if (dm) direction = dm[1];
    const pm = t.match(/(\d{1,2}:\d{2})/); if (pm) post_time = pm[1];
    const wm = t.match(/天候\s*[:：]\s*(\S)/); if (wm) weather = wm[1];
    const tm = t.match(/馬場\s*[:：]\s*(\S)/); if (tm) track = expandTrack(tm[1]);
  }
  return { name: name ? decodeEnt(name).trim() : "", course, surface, distance, direction, post_time, weather, track_condition: track };
}
function expandTrack(c) { return ({ "良": "良", "稍": "稍重", "重": "重", "不": "不良" })[c] || c; }

/* ----------------------------- 共通ユーティリティ ------------------------------ */
async function fetchText(target, enc, extraHeaders) {
  const res = await fetch(target, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en;q=0.9",
      "Referer": "https://race.netkeiba.com/top/race_list.html",
      ...(extraHeaders || {}),
    },
    cf: { cacheTtl: 20, cacheEverything: true },
  });
  if (!res.ok) {
    // 診断用に本文の冒頭を付与（netkeiba が Cloudflare のIPを弾くと 400/403 になることがある）
    let snippet = "";
    try { snippet = (await res.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160); } catch { /* noop */ }
    const e = new Error("netkeiba HTTP " + res.status + " @ " + target +
      (res.status === 400 || res.status === 403
        ? "（Cloudflare からのアクセスが拒否された可能性。worker/KEIBA-GAS-README.md の Google Apps Script 版をお試しください）"
        : "") + (snippet ? " :: " + snippet : ""));
    throw e;
  }
  if (enc && /euc/i.test(enc)) {
    const buf = await res.arrayBuffer();
    return new TextDecoder("euc-jp").decode(buf);
  }
  return await res.text();
}

function num(v) {
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ""); }
function decodeEnt(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function pick(html, rx) { const m = html.match(rx); return m ? m[1] : ""; }

function json(obj, status = 200, cacheSec = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSec ? "public, max-age=" + cacheSec : "no-store",
      ...CORS,
    },
  });
}
function todayJST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
}
