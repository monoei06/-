/**
 * ボートレース直前情報プロキシ（Google Apps Script 版）
 * ---------------------------------------------------------------------------
 * 公式サイト boatrace.jp の「直前情報」ページを取得・解析し、
 * JSON で返す Web アプリです。Google アカウントだけで無料で動きます
 * （Cloudflare のような追加サインアップは不要）。
 *
 * 使い方（アプリからの呼び出し）:
 *   <公開URL>?jcd=<場番号>&rno=<レース番号>&hd=<YYYYMMDD>
 *   例:  ...?jcd=20&rno=6&hd=20260613
 *
 * デプロイ手順は GAS-README.md を参照。
 */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const jcd = String(p.jcd || "").padStart(2, "0");
  const rno = String(p.rno || "");
  const hd = p.hd || todayJST_();

  let out;
  if (!/^\d{1,2}$/.test(jcd) || !/^\d{1,2}$/.test(rno)) {
    out = { error: "jcd と rno は必須です（例: ?jcd=20&rno=6）" };
  } else {
    const target =
      "https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=" + rno +
      "&jcd=" + jcd + "&hd=" + hd;
    try {
      const res = UrlFetchApp.fetch(target, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "ja",
        },
      });
      if (res.getResponseCode() !== 200) {
        out = { error: "official HTTP " + res.getResponseCode(), target };
      } else {
        out = parseBeforeInfo_(res.getContentText("UTF-8"));
        out.stadium = Number(jcd);
        out.race = Number(rno);
        out.date = hd;
        out.source = "boatrace.jp/beforeinfo";
      }
    } catch (err) {
      out = { error: String(err), target };
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// 日本時間の本日を YYYYMMDD で
function todayJST_() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
}

// 公式 beforeinfo の HTML を解析
function parseBeforeInfo_(html) {
  const boats = {};

  // 展示タイム・チルト・体重
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
      tilt: isFinite(tilt) ? tilt : null,
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
    let t = String(s[2]).trim();
    const flying = /F/i.test(t);
    t = t.replace(/[FL]/gi, "");
    if (t.charAt(0) === ".") t = "0" + t;
    if (t.slice(0, 2) === "-.") t = t.replace("-.", "-0.");
    let st = parseFloat(t);
    if (flying && isFinite(st)) st = -st;
    if (boats[boatNo]) {
      boats[boatNo].course = course;
      boats[boatNo].start_timing = isFinite(st) ? st : null;
    }
  }

  // 気象
  const pick = function (rx) { const x = html.match(rx); return x ? x[1] : null; };
  const num = function (v) { return v == null ? null : Number(v); };
  const weather = {
    air_temperature: num(pick(/気温<\/span>\s*<span[^>]*>([\d.]+)℃/)),
    water_temperature: num(pick(/水温<\/span>\s*<span[^>]*>([\d.]+)℃/)),
    wind_speed: num(pick(/風速<\/span>\s*<span[^>]*>(\d+)m/)),
    wave_height: num(pick(/波高<\/span>\s*<span[^>]*>(\d+)cm/)),
    weather_text: pick(/is-weather\d+"><\/p>\s*<div[^>]*>\s*<span[^>]*>([^<]+)<\/span>/),
  };

  const exhibition = Object.keys(boats).some(function (k) { return boats[k].exhibition_time > 0; });
  return { boats: boats, weather: weather, exhibition: exhibition };
}
