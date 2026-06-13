// 中央競馬(JRA) データプロキシ（Google Apps Script 版・貼り付け事故対策版）
// netkeiba の公開ページ・オッズを取得して JSON で返す Web アプリです。
// Cloudflare Workers では netkeiba に弾かれて HTTP 400 になる場合がありますが、
// GAS は Google のIPで動くため取得できることが多く、確実な代替になります。
//
// 使い方:
//   <公開URL>?date=20260613        本日(指定日)の開催・レース一覧
//   <公開URL>?race_id=202602010111 1レースの詳細(出走馬・単勝/複勝オッズ)
//
// 手順は worker/KEIBA-GAS-README.md を参照。
// 重要: デプロイ時「アクセスできるユーザー」を「全員」にしてください。

var UA_ = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 場コード(race_id の 5-6 桁目) → 競馬場名
var PLACE_ = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
  "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉"
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.race_id) {
      if (!/^\d{12}$/.test(p.race_id)) out = { error: "race_id は12桁です" };
      else out = getRace_(p.race_id);
    } else {
      var date = String(p.date || "").replace(/\D/g, "") || todayJST_();
      out = getDay_(date);
    }
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDay_(date) {
  var url = "https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=" + date;
  var html = fetchText_(url, "UTF-8", null);

  var heads = [];
  var hre = /RaceList_DataTitle[^>]*>([\s\S]*?)<\/p>/g;
  var hm;
  while ((hm = hre.exec(html))) heads.push({ idx: hm.index, text: trim_(stripTags_(hm[1]).replace(/\s+/g, " ")) });

  var races = [];
  var ire = /RaceList_DataItem[\s\S]*?race_id=(\d{12})[\s\S]*?ItemTitle">([^<]*)<\/span>[\s\S]*?Itemtime">([^<]*)<\/span>\s*<span class="RaceList_ItemLong[^"]*">([^<]*)<\/span>\s*<span class="RaceList_Itemnumber">([^<]*)<\/span>/g;
  var im;
  while ((im = ire.exec(html))) {
    var rid = im[1];
    var pp = rid.substring(4, 6);
    var head = "";
    for (var i = 0; i < heads.length; i++) { if (heads[i].idx < im.index) head = heads[i].text; else break; }
    races.push({
      race_id: rid, place_code: pp, place: PLACE_[pp] || ("場" + pp), meeting: head,
      race_no: Number(rid.substring(10, 12)), name: trim_(decodeEnt_(im[2])),
      post_time: trim_(im[3]), course: trim_(decodeEnt_(im[4])),
      head_count: parseInt(im[5], 10) || null
    });
  }

  var map = {}, order = [];
  for (var j = 0; j < races.length; j++) {
    var r = races[j];
    if (!map[r.place_code]) { map[r.place_code] = { place_code: r.place_code, place: r.place, meeting: r.meeting, races: [] }; order.push(r.place_code); }
    map[r.place_code].races.push(r);
  }
  order.sort();
  var meetings = [];
  for (var k = 0; k < order.length; k++) {
    map[order[k]].races.sort(function (a, b) { return a.race_no - b.race_no; });
    meetings.push(map[order[k]]);
  }
  return { date: date, meetings: meetings, race_count: races.length, source: "netkeiba race_list_sub (GAS)" };
}

function getRace_(raceId) {
  var base = "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=" + raceId;
  var ref = "https://race.netkeiba.com/odds/index.html?race_id=" + raceId;
  var shutubaURL = "https://race.netkeiba.com/race/shutuba.html?race_id=" + raceId;
  var pastURL = "https://race.netkeiba.com/race/shutuba_past.html?race_id=" + raceId;
  var H = {
    "User-Agent": UA_, "Accept-Language": "ja,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Referer": ref
  };
  var HS = { "User-Agent": UA_, "Accept-Language": "ja" };
  // 単複(1)・馬連(4)・ワイド(5)・3連複(7)・3連単(8)・出走表・馬柱(近走) を並行取得
  var reqs = [
    { url: base + "&type=1&action=update", headers: H, muteHttpExceptions: true, followRedirects: true },
    { url: base + "&type=4&action=update", headers: H, muteHttpExceptions: true, followRedirects: true },
    { url: base + "&type=5&action=update", headers: H, muteHttpExceptions: true, followRedirects: true },
    { url: base + "&type=7&action=update", headers: H, muteHttpExceptions: true, followRedirects: true },
    { url: base + "&type=8&action=update", headers: H, muteHttpExceptions: true, followRedirects: true },
    { url: shutubaURL, headers: HS, muteHttpExceptions: true, followRedirects: true },
    { url: pastURL, headers: HS, muteHttpExceptions: true, followRedirects: true }
  ];
  var res = UrlFetchApp.fetchAll(reqs);
  if (res[0].getResponseCode() !== 200) throw new Error("netkeiba HTTP " + res[0].getResponseCode());

  var o1 = res[0].getContentText("UTF-8");
  var shutuba = "", spast = "";
  try { shutuba = res[5].getContentText("EUC-JP"); } catch (e) { shutuba = ""; }
  try { spast = res[6].getContentText("EUC-JP"); } catch (e2) { spast = ""; }
  var pastMap = parsePast_(spast);

  var win = {}, place = {}, official = "", status = "";
  try {
    var oj = JSON.parse(o1);
    var od = (oj && oj.data && oj.data.odds) ? oj.data.odds : {};
    win = od["1"] || {};
    place = od["2"] || {};
    official = (oj && oj.data && oj.data.official_datetime) || "";
    status = (oj && oj.status) || "";
  } catch (e2) { /* オッズ未発表でも続行 */ }

  var pools = {
    umaren: poolMap_(textOf_(res[1]), "4", false),
    wide: poolMap_(textOf_(res[2]), "5", true),
    trio: poolMap_(textOf_(res[3]), "7", false),
    trifecta: poolMap_(textOf_(res[4]), "8", false)
  };

  var meta = parseShutuba_(shutuba);
  var head = parseRaceHead_(shutuba);

  var numset = {}, kk;
  for (kk in win) numset[String(parseInt(kk, 10))] = 1;
  for (kk in meta) numset[String(parseInt(kk, 10))] = 1;

  var horses = [];
  for (var ns in numset) {
    var pad = ("0" + ns).slice(-2);
    var w = win[pad] || win[ns];
    var p = place[pad] || place[ns];
    var m = meta[ns] || {};
    horses.push({
      num: Number(ns), waku: m.waku != null ? m.waku : null, name: m.name || ("馬" + ns),
      jockey: m.jockey || "", sexage: m.sexage || "",
      weight_carry: m.weight_carry != null ? m.weight_carry : null,
      weight: m.weight != null ? m.weight : null,
      weight_diff: m.weight_diff != null ? m.weight_diff : null,
      win_odds: w ? num_(w[0]) : null,
      place_min: p ? num_(p[0]) : null,
      place_max: p ? num_(p[1]) : null,
      popularity: w ? (parseInt(w[2], 10) || null) : (p ? parseInt(p[2], 10) || null : null),
      past: pastMap[ns] || []
    });
  }
  horses.sort(function (a, b) { return a.num - b.num; });

  var pp = raceId.substring(4, 6);
  var hasOdds = false;
  for (var z = 0; z < horses.length; z++) if (horses[z].win_odds > 0) hasOdds = true;

  return {
    race_id: raceId, place_code: pp, place: PLACE_[pp] || ("場" + pp),
    race_no: Number(raceId.substring(10, 12)), name: head.name || "", course: head.course || "",
    surface: head.surface || "", distance: head.distance || null, direction: head.direction || "",
    weather: head.weather || "", track_condition: head.track_condition || "",
    post_time: head.post_time || "", official_datetime: official, odds_status: status,
    has_odds: hasOdds, pools: pools, horses: horses, source: "netkeiba odds(1/4/5/7/8)+shutuba (GAS)"
  };
}

function textOf_(res) {
  try { return res.getResponseCode() === 200 ? res.getContentText("UTF-8") : ""; } catch (e) { return ""; }
}

function poolMap_(text, key, isRange) {
  var out = {};
  if (!text) return out;
  try {
    var oj = JSON.parse(text);
    var od = (oj && oj.data && oj.data.odds) ? oj.data.odds[key] : null;
    if (!od) return out;
    for (var k in od) {
      var v = od[k];
      out[k] = isRange ? [num_(v[0]), num_(v[1])] : num_(v[0]);
    }
  } catch (e) { /* 未発売でも続行 */ }
  return out;
}

function parseShutuba_(html) {
  var out = {};
  if (!html) return out;
  var rows = html.split(/<tr class="HorseList/);
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var um = r.match(/<td class="Umaban\d+[^"]*">\s*(\d+)\s*</);
    if (!um) continue;
    var n = String(parseInt(um[1], 10));
    var waku = r.match(/Waku(\d+)/);
    var nm = r.match(/<span class="HorseName"><a[^>]*title="([^"]+)"/);
    var ba = r.match(/<td class="Barei[^"]*">([^<]*)</);
    var kin = r.match(/<td class="Txt_C">([\d.]+)<\/td>/);
    var jk = r.match(/<td class="Jockey">\s*<a[^>]*>\s*([^<]+?)\s*</);
    var wt = r.match(/<td class="Weight">\s*(\d+)?\s*(?:<small>\(([-+]?\d+)\)<\/small>)?/);
    out[n] = {
      waku: waku ? Number(waku[1]) : null,
      name: nm ? trim_(decodeEnt_(nm[1])) : ("馬" + n),
      sexage: ba ? trim_(decodeEnt_(ba[1])) : "",
      weight_carry: kin ? num_(kin[1]) : null,
      jockey: jk ? trim_(decodeEnt_(jk[1])) : "",
      weight: wt && wt[1] ? num_(wt[1]) : null,
      weight_diff: wt && wt[2] != null ? num_(wt[2]) : null
    };
  }
  return out;
}

function parsePast_(html) {
  var out = {};
  if (!html) return out;
  var rows = html.split(/<tr class="HorseList/);
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var um = r.match(/<td class="Waku">\s*(\d+)\s*<\/td>/);
    if (!um) continue;
    var n = String(parseInt(um[1], 10));
    var arr = [];
    var cells = r.match(/<td class="Past"[^>]*>[\s\S]*?<\/td>/g) || [];
    for (var j = 0; j < cells.length; j++) {
      var c = cells[j];
      var d05 = pick_(c, /<div class="Data05">([\s\S]*?)<\/div>/);
      if (!d05) continue;
      var t05 = stripTags_(d05).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
      var cm = t05.match(/(芝|ダ|障)(\d+)\s+(\d):(\d{2})\.(\d)\s*(\S)?/);
      if (!cm) continue;
      var d01 = stripTags_(pick_(c, /<div class="Data01">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
      var klass = stripTags_(pick_(c, /<div class="Data02">([\s\S]*?)<\/div>/)).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
      var d03 = stripTags_(pick_(c, /<div class="Data03">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
      var d06 = stripTags_(pick_(c, /<div class="Data06">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
      var d07 = stripTags_(pick_(c, /<div class="Data07">([\s\S]*?)<\/div>/)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
      var dm = d01.match(/([\d.]+)\s+(\S+)/), fld = d03.match(/(\d+)頭/), pop = d03.match(/(\d+)人/),
        ag = d06.match(/\((\d{2}\.\d)\)/), bw = d06.match(/(\d{3})\(([-+]?\d+)\)/), mg = d07.match(/\((-?[\d.]+)\)/);
      arr.push({
        ymd: dm ? dm[1] : "", place: dm ? dm[2] : "", klass: klass,
        surface: cm[1], dist: Number(cm[2]),
        sec: Number(cm[3]) * 60 + Number(cm[4]) + Number(cm[5]) / 10,
        going: cm[6] || "", field: fld ? Number(fld[1]) : null, pop: pop ? Number(pop[1]) : null,
        agari: ag ? Number(ag[1]) : null, body: bw ? Number(bw[1]) : null, bdiff: bw ? Number(bw[2]) : null,
        margin: mg ? Number(mg[1]) : null
      });
      if (arr.length >= 5) break;
    }
    if (arr.length) out[n] = arr;
  }
  return out;
}

function parseRaceHead_(html) {
  if (!html) return {};
  var name = pick_(html, /RaceName[^>]*>\s*([^<]+?)\s*</) || pick_(html, /<title>([^|<]+)/);
  var data = pick_(html, /<div class="RaceData01">([\s\S]*?)<\/div>/);
  var course = "", post_time = "", surface = "", distance = null, direction = "", weather = "", track = "";
  if (data) {
    var t = stripTags_(data).replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    var cm = t.match(/(芝|ダ|障)[^\d]*(\d+)m/);
    if (cm) { surface = cm[1]; distance = Number(cm[2]); course = cm[1] + cm[2] + "m"; }
    var dm = t.match(/[(（](左|右|直)/); if (dm) direction = dm[1];
    var pm = t.match(/(\d{1,2}:\d{2})/); if (pm) post_time = pm[1];
    var wm = t.match(/天候\s*[:：]\s*(\S)/); if (wm) weather = wm[1];
    var tm = t.match(/馬場\s*[:：]\s*(\S)/); if (tm) track = expandTrack_(tm[1]);
  }
  return { name: name ? trim_(decodeEnt_(name)) : "", course: course, surface: surface, distance: distance, direction: direction, post_time: post_time, weather: weather, track_condition: track };
}
function expandTrack_(c) { var m = { "良": "良", "稍": "稍重", "重": "重", "不": "不良" }; return m[c] || c; }

function fetchText_(url, enc, extra) {
  var headers = {
    "User-Agent": UA_, "Accept-Language": "ja,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (extra) for (var k in extra) headers[k] = extra[k];
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: headers });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error("netkeiba HTTP " + code + " @ " + url);
  return res.getContentText(enc || "UTF-8");
}

function todayJST_() {
  var d = new Date(Date.now() + 32400000);
  var mm = String(d.getUTCMonth() + 1); if (mm.length < 2) mm = "0" + mm;
  var dd = String(d.getUTCDate()); if (dd.length < 2) dd = "0" + dd;
  return String(d.getUTCFullYear()) + mm + dd;
}

function num_(v) { var n = parseFloat(String(v).replace(/,/g, "")); return isFinite(n) ? n : null; }
function stripTags_(s) { return String(s).replace(/<[^>]*>/g, ""); }
function trim_(s) { return String(s).replace(/^\s+|\s+$/g, ""); }
function pick_(html, rx) { var m = String(html).match(rx); return m ? m[1] : ""; }
function isEmpty_(o) { for (var k in o) return false; return true; }
function decodeEnt_(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
