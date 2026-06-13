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
  const oddsURL =
    "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=" + raceId + "&type=1&action=update";
  const shutubaURL = "https://race.netkeiba.com/race/shutuba.html?race_id=" + raceId;

  const [oddsRes, shutuba] = await Promise.all([
    fetchText(oddsURL, "utf-8", { Referer: "https://race.netkeiba.com/odds/index.html?race_id=" + raceId }),
    fetchText(shutubaURL, "euc-jp").catch(() => ""),
  ]);

  // オッズJSON
  let win = {}, place = {}, official = "";
  try {
    const oj = JSON.parse(oddsRes);
    const od = oj && oj.data && oj.data.odds ? oj.data.odds : {};
    win = od["1"] || {};
    place = od["2"] || {};
    official = (oj && oj.data && oj.data.official_datetime) || "";
  } catch { /* オッズ未発表でも続行 */ }

  // 出走表(EUC-JP)から 馬番→馬名/騎手/性齢/斤量
  const meta = parseShutuba(shutuba);

  // 馬番の集合（オッズ or 出走表の和）
  const nums = new Set([...Object.keys(win), ...Object.keys(meta)].map((k) => String(parseInt(k, 10))));
  const horses = [];
  for (const ns of nums) {
    const pad = ns.padStart(2, "0");
    const w = win[pad] || win[ns];
    const p = place[pad] || place[ns];
    const m = meta[ns] || {};
    horses.push({
      num: Number(ns),
      name: m.name || ("馬" + ns),
      jockey: m.jockey || "",
      sexage: m.sexage || "",
      weight: m.weight || null,
      win_odds: w ? num(w[0]) : null,
      place_min: p ? num(p[0]) : null,
      place_max: p ? num(p[1]) : null,
      popularity: w ? (parseInt(w[2], 10) || null) : (p ? parseInt(p[2], 10) || null : null),
    });
  }
  horses.sort((a, b) => a.num - b.num);

  const pp = raceId.slice(4, 6);
  // 出走表からレース名/距離（一覧と二重化のフォールバック）
  const head = parseRaceHead(shutuba);

  return {
    race_id: raceId,
    place_code: pp,
    place: PLACE[pp] || ("場" + pp),
    race_no: Number(raceId.slice(10, 12)),
    name: head.name || "",
    course: head.course || "",
    post_time: head.post_time || "",
    official_datetime: official,
    has_odds: horses.some((h) => h.win_odds > 0),
    horses,
    source: "netkeiba odds API + shutuba",
  };
}

// 出走表HTML(EUC-JP→UTF-8済)から 馬番→{name,jockey,sexage,weight}
function parseShutuba(html) {
  const out = {};
  if (!html) return out;
  // 行構造: Umaban → HorseInfo(span.HorseName) → Barei(性齢) → Txt_C(斤量) → Jockey
  const re =
    /<td class="Umaban\d+[^"]*">\s*(\d+)\s*<\/td>[\s\S]*?<span class="HorseName"><a[^>]*title="([^"]+)"[\s\S]*?<td class="Barei[^"]*">([^<]*)<\/td>\s*<td class="Txt_C">([^<]*)<\/td>\s*<td class="Jockey">\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const n = String(parseInt(m[1], 10));
    out[n] = {
      name: decodeEnt(m[2]).trim(),
      sexage: decodeEnt(m[3]).trim(),
      weight: num(m[4]),
      jockey: decodeEnt(m[5]).trim(),
    };
  }
  // フォールバック: 上の厳密版が取れない場合は馬番と馬名だけでも対応付ける
  if (Object.keys(out).length === 0) {
    const nums = [...html.matchAll(/<td class="Umaban\d+[^"]*">\s*(\d+)\s*<\/td>/g)].map((x) => parseInt(x[1], 10));
    const names = [...html.matchAll(/<span class="HorseName"><a[^>]*title="([^"]+)"/g)].map((x) => decodeEnt(x[1]).trim());
    for (let i = 0; i < Math.min(nums.length, names.length); i++) out[String(nums[i])] = { name: names[i] };
  }
  return out;
}

// 出走表HTMLからレース名・距離・発走時刻
function parseRaceHead(html) {
  if (!html) return {};
  const name = pick(html, /RaceName[^>]*>\s*([^<]+?)\s*</) || pick(html, /<title>([^|<]+)/);
  const data = pick(html, /<div class="RaceData01">([\s\S]*?)<\/div>/);
  let course = "", post_time = "";
  if (data) {
    const t = stripTags(data).replace(/\s+/g, " ");
    const cm = t.match(/(芝|ダ|障)[^\d]*\d+m/);
    if (cm) course = cm[0].replace(/\s/g, "");
    const pm = t.match(/(\d{1,2}:\d{2})/);
    if (pm) post_time = pm[1];
  }
  return { name: name ? decodeEnt(name).trim() : "", course, post_time };
}

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
  const n = parseFloat(String(v));
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
