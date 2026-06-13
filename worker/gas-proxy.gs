// ボートレース直前情報プロキシ（Google Apps Script 版・貼り付け事故対策版）
// 使い方:  <公開URL>?jcd=20&rno=6&hd=20260613
//   JSONPで使う場合:  ...&callback=関数名   （ブラウザからの呼び出しはこちら）
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
  } else if (p.mode === "predict") {
    // Claude(API)に予想させるモード
    out = claudePredict_(jcd, rno, hd);
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

  var text = JSON.stringify(out);
  // JSONP: callback 指定時は JavaScript として返す（ブラウザのCORS制約を回避）
  var cb = String(p.callback || "");
  if (cb && /^[A-Za-z0-9_$.]+$/.test(cb)) {
    return ContentService.createTextOutput(cb + "(" + text + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// ===== Claude(API)による予想 =====
// 使用モデル（変えたい場合はここを claude-sonnet-4-6 / claude-haiku-4-5 などに）
var CLAUDE_MODEL = "claude-opus-4-8";
var STAD_NAME = {1:"桐生",2:"戸田",3:"江戸川",4:"平和島",5:"多摩川",6:"浜名湖",7:"蒲郡",8:"常滑",9:"津",10:"三国",11:"びわこ",12:"住之江",13:"尼崎",14:"鳴門",15:"丸亀",16:"児島",17:"宮島",18:"徳山",19:"下関",20:"若松",21:"芦屋",22:"福岡",23:"唐津",24:"大村"};
var CLASS_NAME = {1:"A1",2:"A2",3:"B1",4:"B2"};

function claudePredict_(jcd, rno, hd) {
  var KEY = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!KEY) return { error: "no_api_key", message: "GASのスクリプトプロパティに ANTHROPIC_API_KEY を設定してください" };

  var st = Number(jcd);
  // 出走表（プログラム）を取得（キャッシュ1時間）
  var prog = getPrograms_(hd);
  if (!prog) return { error: "programs_fetch_failed" };
  var race = null;
  for (var i = 0; i < prog.length; i++) {
    if (prog[i].race_stadium_number === st && prog[i].race_number === Number(rno)) { race = prog[i]; break; }
  }
  if (!race) return { error: "race_not_found" };

  // 直前情報（展示）
  var pv = null;
  try {
    var bf = UrlFetchApp.fetch("https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=" + rno + "&jcd=" + jcd + "&hd=" + hd, {
      muteHttpExceptions: true, followRedirects: true,
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ja" }
    });
    if (bf.getResponseCode() === 200) pv = parseBeforeInfo_(bf.getContentText("UTF-8"));
  } catch (e1) { pv = null; }
  var hasEx = !!(pv && pv.exhibition);

  // Claudeに渡すデータを組み立て
  var lines = [];
  for (var b = 0; b < race.boats.length; b++) {
    var x = race.boats[b], n = x.racer_boat_number;
    var e = (hasEx && pv.boats && pv.boats[n]) ? pv.boats[n] : null;
    var s = n + "号艇 " + (x.racer_name || "") + " " + (CLASS_NAME[x.racer_class_number] || "") +
      " 全国勝率" + x.racer_national_top_1_percent + " 全国2連率" + x.racer_national_top_2_percent + "% 全国3連率" + x.racer_national_top_3_percent + "%" +
      " 当地勝率" + x.racer_local_top_1_percent + " 当地2連率" + x.racer_local_top_2_percent + "%" +
      " 平均ST" + x.racer_average_start_timing + " モーター2連率" + x.racer_assigned_motor_top_2_percent + "% ボート2連率" + x.racer_assigned_boat_top_2_percent + "%" +
      " F" + x.racer_flying_count + " L" + x.racer_late_count;
    if (e) s += " ｜進入" + e.course + "コース 展示タイム" + e.exhibition_time + " 展示ST" + e.start_timing + " チルト" + e.tilt;
    lines.push(s);
  }
  var weather = "";
  if (pv) weather = "天候/風速" + (pv.weather && pv.weather.wind_speed) + "m 波" + (pv.weather && pv.weather.wave_height) + "cm";

  var prompt =
    "あなたは競艇(ボートレース)の超一流予想家です。以下のレースデータから、各艇の1着率・2着率・3着率を推定してください。\n" +
    "ボートレースは1コース(インコース)が最も有利で、選手の実力・モーター・スタート・" + (hasEx ? "当日の展示タイムや進入コース・" : "") + "場の特性を総合的に考慮します。\n\n" +
    "会場: " + (STAD_NAME[st] || st) + " " + rno + "R" + (race.race_title ? " (" + race.race_title + ")" : "") + "\n" +
    (weather ? weather + "\n" : "") +
    (hasEx ? "※展示(直前情報)あり\n" : "※展示前(出走表のみ)\n") +
    "\n各艇データ:\n" + lines.join("\n") + "\n\n" +
    "次のJSONのみを出力してください(前後の説明やマークダウン記号は一切不要):\n" +
    '{"race_comment":"レース全体の見解(100字程度)","boats":[{"boat":1,"mark":"◎or○or▲or△or×or無","win":0.0-1.0,"place2":0.0-1.0,"place3":0.0-1.0,"reason":"短評(40字程度)"}, ... 6艇]}\n' +
    "win/place2/place3はそれぞれ1着/2着/3着になる確率(0〜1)。各列の6艇合計はそれぞれ概ね1.0。markは上位から◎○▲△×、残り2艇は無。";

  try {
    var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      payload: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    var code = resp.getResponseCode();
    var body = JSON.parse(resp.getContentText());
    if (code !== 200) return { error: "claude HTTP " + code, detail: body };
    var txt = "";
    for (var c = 0; c < body.content.length; c++) { if (body.content[c].type === "text") { txt = body.content[c].text; break; } }
    txt = txt.replace(/^[\s\S]*?\{/, "{").replace(/\}[\s\S]*$/, "}"); // 前後の余計な文字を除去
    var pred = JSON.parse(txt);
    return {
      source: "claude", model: CLAUDE_MODEL,
      stadium: st, race: Number(rno), date: hd,
      exhibition: hasEx, weather: pv ? pv.weather : null,
      prediction: pred
    };
  } catch (e2) {
    return { error: "claude_call_failed", message: String(e2) };
  }
}

// 出走表を取得（CacheServiceで1時間キャッシュ）
function getPrograms_(hd) {
  var cache = CacheService.getScriptCache();
  var key = "prog_" + hd;
  var cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  var y = hd.slice(0, 4);
  var url = "https://boatraceopenapi.github.io/programs/v2/" + y + "/" + hd + ".json";
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) {
      // 当日分のフォールバック
      r = UrlFetchApp.fetch("https://boatraceopenapi.github.io/programs/v2/today.json", { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) return null;
    }
    var programs = JSON.parse(r.getContentText()).programs || [];
    try { cache.put(key, JSON.stringify(programs), 3600); } catch (e3) {}
    return programs;
  } catch (e) { return null; }
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
