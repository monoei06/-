// ボートレース直前情報プロキシ（Google Apps Script 版・貼り付け事故対策版）
// 使い方:  <公開URL>?jcd=20&rno=6&hd=20260613
// 手順は GAS-README.md を参照。

function doGet(e) {
  var p = (e && e.parameter) || {};
  var jcd = String(p.jcd || "");
  while (jcd.length < 2) jcd = "0" + jcd;
  var rno = String(p.rno || "");
  var hd = p.hd || todayJST_();

  var out;
  if (!/^\d{1,2}$/.test(jcd) || !/^\d{1,2}$/.test(rno)) {
    out = { error: "jcd rno required" };
  } else {
    var target = "https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=" + rno + "&jcd=" + jcd + "&hd=" + hd;
    try {
      var res = UrlFetchApp.fetch(target, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "ja"
        }
      });
      if (res.getResponseCode() !== 200) {
        out = { error: "official HTTP " + res.getResponseCode() };
      } else {
        out = parseBeforeInfo_(res.getContentText("UTF-8"));
        out.stadium = Number(jcd);
        out.race = Number(rno);
        out.date = hd;
      }
    } catch (err) {
      out = { error: String(err) };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function todayJST_() {
  var d = new Date(Date.now() + 32400000);
  var mm = String(d.getUTCMonth() + 1);
  if (mm.length < 2) mm = "0" + mm;
  var dd = String(d.getUTCDate());
  if (dd.length < 2) dd = "0" + dd;
  return String(d.getUTCFullYear()) + mm + dd;
}

function parseBeforeInfo_(html) {
  var boats = {};
  var re = /profile\?toban=(\d+)">[^<]*<\/a><\/td>\s*<td[^>]*rowspan="2">([\d.]+)kg<\/td>\s*<td rowspan="4">([\d.]+)<\/td>\s*<td rowspan="4">(-?[\d.]+|&nbsp;)<\/td>/g;
  var m, idx = 0;
  while ((m = re.exec(html))) {
    idx++;
    var tilt = m[4] === "&nbsp;" ? null : parseFloat(m[4]);
    boats[idx] = {
      boat: idx,
      toban: Number(m[1]),
      weight: parseFloat(m[2]),
      exhibition_time: parseFloat(m[3]),
      tilt: isFinite(tilt) ? tilt : null,
      course: null,
      start_timing: null
    };
  }

  var sec = html.slice(html.indexOf("スタート展示"));
  var sre = /is-type(\d)">\d<\/span>[\s\S]*?table1_boatImage1Time">([^<]*)<\/span>/g;
  var s, course = 0;
  while ((s = sre.exec(sec)) && course < 6) {
    course++;
    var boatNo = Number(s[1]);
    var t = String(s[2]).replace(/\s/g, "");
    var flying = /F/i.test(t);
    t = t.replace(/[FL]/gi, "");
    if (t.charAt(0) === ".") t = "0" + t;
    if (t.slice(0, 2) === "-.") t = t.replace("-.", "-0.");
    var st = parseFloat(t);
    if (flying && isFinite(st)) st = -st;
    if (boats[boatNo]) {
      boats[boatNo].course = course;
      boats[boatNo].start_timing = isFinite(st) ? st : null;
    }
  }

  var weather = {
    air_temperature: pickNum_(html, /気温<\/span>\s*<span[^>]*>([\d.]+)/),
    water_temperature: pickNum_(html, /水温<\/span>\s*<span[^>]*>([\d.]+)/),
    wind_speed: pickNum_(html, /風速<\/span>\s*<span[^>]*>(\d+)/),
    wave_height: pickNum_(html, /波高<\/span>\s*<span[^>]*>(\d+)/),
    weather_text: pickStr_(html, /is-weather\d+"><\/p>\s*<div[^>]*>\s*<span[^>]*>([^<]+)<\/span>/)
  };

  var exhibition = false;
  for (var k in boats) { if (boats[k].exhibition_time > 0) exhibition = true; }
  return { boats: boats, weather: weather, exhibition: exhibition };
}

function pickStr_(html, rx) { var x = html.match(rx); return x ? x[1] : null; }
function pickNum_(html, rx) { var x = html.match(rx); return x ? Number(x[1]) : null; }
