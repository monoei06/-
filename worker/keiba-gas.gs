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
  var oddsURL = "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=" + raceId + "&type=1&action=update";
  var shutubaURL = "https://race.netkeiba.com/race/shutuba.html?race_id=" + raceId;

  var oddsRes = fetchText_(oddsURL, "UTF-8", { "Referer": "https://race.netkeiba.com/odds/index.html?race_id=" + raceId });
  var shutuba = "";
  try { shutuba = fetchText_(shutubaURL, "EUC-JP", null); } catch (e) { shutuba = ""; }

  var win = {}, place = {}, official = "";
  try {
    var oj = JSON.parse(oddsRes);
    var od = (oj && oj.data && oj.data.odds) ? oj.data.odds : {};
    win = od["1"] || {};
    place = od["2"] || {};
    official = (oj && oj.data && oj.data.official_datetime) || "";
  } catch (e2) { /* オッズ未発表でも続行 */ }

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
      num: Number(ns), name: m.name || ("馬" + ns), jockey: m.jockey || "",
      sexage: m.sexage || "", weight: m.weight || null,
      win_odds: w ? num_(w[0]) : null,
      place_min: p ? num_(p[0]) : null,
      place_max: p ? num_(p[1]) : null,
      popularity: w ? (parseInt(w[2], 10) || null) : (p ? parseInt(p[2], 10) || null : null)
    });
  }
  horses.sort(function (a, b) { return a.num - b.num; });

  var pp = raceId.substring(4, 6);
  var hasOdds = false;
  for (var z = 0; z < horses.length; z++) if (horses[z].win_odds > 0) hasOdds = true;

  return {
    race_id: raceId, place_code: pp, place: PLACE_[pp] || ("場" + pp),
    race_no: Number(raceId.substring(10, 12)), name: head.name || "", course: head.course || "",
    post_time: head.post_time || "", official_datetime: official, has_odds: hasOdds,
    horses: horses, source: "netkeiba odds+shutuba (GAS)"
  };
}

function parseShutuba_(html) {
  var out = {};
  if (!html) return out;
  var re = /<td class="Umaban\d+[^"]*">\s*(\d+)\s*<\/td>[\s\S]*?<span class="HorseName"><a[^>]*title="([^"]+)"[\s\S]*?<td class="Barei[^"]*">([^<]*)<\/td>\s*<td class="Txt_C">([^<]*)<\/td>\s*<td class="Jockey">\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/g;
  var m;
  while ((m = re.exec(html))) {
    var n = String(parseInt(m[1], 10));
    out[n] = { name: trim_(decodeEnt_(m[2])), sexage: trim_(m[3]), weight: num_(m[4]), jockey: trim_(decodeEnt_(m[5])) };
  }
  if (isEmpty_(out)) {
    var nre = /<td class="Umaban\d+[^"]*">\s*(\d+)\s*<\/td>/g, hre = /<span class="HorseName"><a[^>]*title="([^"]+)"/g;
    var nums = [], names = [], x;
    while ((x = nre.exec(html))) nums.push(parseInt(x[1], 10));
    while ((x = hre.exec(html))) names.push(trim_(decodeEnt_(x[1])));
    for (var i = 0; i < Math.min(nums.length, names.length); i++) out[String(nums[i])] = { name: names[i] };
  }
  return out;
}

function parseRaceHead_(html) {
  if (!html) return {};
  var name = pick_(html, /RaceName[^>]*>\s*([^<]+?)\s*</) || pick_(html, /<title>([^|<]+)/);
  var data = pick_(html, /<div class="RaceData01">([\s\S]*?)<\/div>/);
  var course = "", post_time = "";
  if (data) {
    var t = stripTags_(data).replace(/\s+/g, " ");
    var cm = t.match(/(芝|ダ|障)[^\d]*\d+m/);
    if (cm) course = cm[0].replace(/\s/g, "");
    var pm = t.match(/(\d{1,2}:\d{2})/);
    if (pm) post_time = pm[1];
  }
  return { name: name ? trim_(decodeEnt_(name)) : "", course: course, post_time: post_time };
}

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

function num_(v) { var n = parseFloat(String(v)); return isFinite(n) ? n : null; }
function stripTags_(s) { return String(s).replace(/<[^>]*>/g, ""); }
function trim_(s) { return String(s).replace(/^\s+|\s+$/g, ""); }
function pick_(html, rx) { var m = String(html).match(rx); return m ? m[1] : ""; }
function isEmpty_(o) { for (var k in o) return false; return true; }
function decodeEnt_(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
