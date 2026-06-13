/**
 * ボートレース直前情報プロキシ (Cloudflare Workers)
 * ---------------------------------------------------------------------------
 * 公式サイト boatrace.jp の「直前情報」ページを取得・解析し、
 * CORS 許可つき JSON で返す小さなプロキシです。
 * これにより、スマホ上の静的HTMLアプリから締切前の展示タイム等を取得できます。
 *
 * 使い方:  GET /?jcd=<場番号>&rno=<レース番号>&hd=<YYYYMMDD>
 *   例:    /?jcd=20&rno=6&hd=20260613   （若松6R / 2026-06-13）
 *   hd 省略時は日本時間の本日。
 *
 * デプロイ: 同フォルダの README.md を参照（Cloudflare 無料枠で動きます）。
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const jcd = (url.searchParams.get("jcd") || "").padStart(2, "0");
    const rno = url.searchParams.get("rno") || "";
    const hd = url.searchParams.get("hd") || todayJST();

    if (!/^\d{1,2}$/.test(jcd) || !/^\d{1,2}$/.test(rno)) {
      return json({ error: "jcd と rno は必須です（例: ?jcd=20&rno=6）" }, 400);
    }

    const target =
      `https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${rno}&jcd=${jcd}&hd=${hd}`;

    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "ja",
        },
        cf: { cacheTtl: 30, cacheEverything: true },
      });
      if (!res.ok) return json({ error: "official HTTP " + res.status, target }, 502);
      const html = await res.text();
      const data = parseBeforeInfo(html);
      data.stadium = Number(jcd);
      data.race = Number(rno);
      data.date = hd;
      data.source = "boatrace.jp/beforeinfo";
      return json(data, 200, 30);
    } catch (e) {
      return json({ error: String(e && e.message || e), target }, 502);
    }
  },
};

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

// 日本時間の本日を YYYYMMDD で返す
function todayJST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
}

// 公式 beforeinfo の HTML を解析して直前情報を抽出
function parseBeforeInfo(html) {
  const boats = {};

  // 展示タイム・チルト・体重（選手プロフィールリンクの直後セル）
  const re =
    /profile\?toban=(\d+)">[^<]*<\/a><\/td>\s*<td[^>]*rowspan="2">([\d.]+)kg<\/td>\s*<td rowspan="4">([\d.]+)<\/td>\s*<td rowspan="4">(-?[\d.]+|&nbsp;)<\/td>/g;
  let m, idx = 0;
  while ((m = re.exec(html))) {
    idx++;
    const tilt = m[4] === "&nbsp;" ? null : parseFloat(m[4]);
    boats[idx] = {
      boat: idx,
      toban: Number(m[1]),
      weight: parseFloat(m[2]),
      exhibition_time: parseFloat(m[3]),
      tilt: Number.isFinite(tilt) ? tilt : null,
      course: null,
      start_timing: null,
    };
  }

  // スタート展示：行順=進入コース, is-typeN=艇番, Time=展示ST
  const sec = html.slice(html.indexOf("スタート展示"));
  const sre =
    /is-type(\d)">\d<\/span>[\s\S]*?table1_boatImage1Time">([^<]*)<\/span>/g;
  let s, course = 0;
  while ((s = sre.exec(sec)) && course < 6) {
    course++;
    const boatNo = Number(s[1]);
    let t = s[2].trim();
    const flying = /F/i.test(t);
    t = t.replace(/[FL]/gi, "");
    if (t.startsWith(".")) t = "0" + t;
    if (t.startsWith("-.")) t = t.replace("-.", "-0.");
    let st = parseFloat(t);
    if (flying && Number.isFinite(st)) st = -st;
    if (boats[boatNo]) {
      boats[boatNo].course = course;
      boats[boatNo].start_timing = Number.isFinite(st) ? st : null;
    }
  }

  // 気象
  const pick = (rx) => { const x = html.match(rx); return x ? x[1] : null; };
  const weather = {
    air_temperature: numOrNull(pick(/気温<\/span>\s*<span[^>]*>([\d.]+)℃/)),
    water_temperature: numOrNull(pick(/水温<\/span>\s*<span[^>]*>([\d.]+)℃/)),
    wind_speed: numOrNull(pick(/風速<\/span>\s*<span[^>]*>(\d+)m/)),
    wave_height: numOrNull(pick(/波高<\/span>\s*<span[^>]*>(\d+)cm/)),
    weather_text: pick(/is-weather\d+"><\/p>\s*<div[^>]*>\s*<span[^>]*>([^<]+)<\/span>/),
  };

  const exhibition = Object.values(boats).some((b) => b.exhibition_time > 0);
  return { boats, weather, exhibition };
}

function numOrNull(v) { return v == null ? null : Number(v); }
