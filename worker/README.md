# 直前情報サーバー（Cloudflare Workers）デプロイ手順

このフォルダの `boatrace-proxy.js` は、公式サイト boatrace.jp の「直前情報」ページを
取得・解析して **CORS 許可つき JSON** で返す小さなプロキシです。
これをデプロイしてアプリに登録すると、**締切前の展示タイム・展示ST・チルト・進入コース・気象**を
公式から自動取得できます。**Cloudflare の無料枠（1日10万リクエスト）で十分動きます。**

---

## 方法A：ダッシュボードに貼り付け（最速・5分・PCでもスマホでも可）

1. https://dash.cloudflare.com/ にログイン（無料アカウント作成）
2. 左メニュー **Workers & Pages** →「**Create application**」→「**Create Worker**」
3. 適当な名前（例 `boatrace`）→「**Deploy**」
4. デプロイ後「**Edit code**」を開き、エディタの中身を**全部消して**、
   `boatrace-proxy.js` の中身を**まるごと貼り付け**→「**Deploy**」
5. 画面に出る URL（例 `https://boatrace.あなた.workers.dev`）をコピー
6. ボートレース予想アプリの **⚙️直前情報サーバー設定** にその URL を貼り付け

これで「予想する」を押すと、締切前でも公式から展示を取得して予想に反映します。

---

## 方法B：Wrangler CLI（PC向け）

```bash
npm install -g wrangler
wrangler login
# このフォルダで:
wrangler deploy boatrace-proxy.js --name boatrace --compatibility-date 2024-11-01
```

出力された `https://boatrace.<account>.workers.dev` をアプリに登録します。

---

## 動作確認

ブラウザで次を開き、JSON が返れば成功です（若松6R・2026-06-13 の例）:

```
https://boatrace.あなた.workers.dev/?jcd=20&rno=6&hd=20260613
```

```jsonc
{
  "boats": {
    "1": { "boat":1, "exhibition_time":6.77, "tilt":0, "course":1, "start_timing":0.08, ... },
    ...
  },
  "weather": { "air_temperature":25, "wind_speed":3, "wave_height":3, "weather_text":"曇り", ... },
  "exhibition": true,
  "stadium": 20, "race": 6, "date": "20260613"
}
```

## パラメータ

| 名前 | 内容 | 例 |
| --- | --- | --- |
| `jcd` | 場番号（1〜24。桐生=01 … 大村=24） | `20`（若松） |
| `rno` | レース番号（1〜12） | `6` |
| `hd` | 日付 YYYYMMDD（省略時=日本時間の本日） | `20260613` |

## 注意

- 公式ページの HTML 構造が変わると解析が壊れる可能性があります（その場合は `parseBeforeInfo` の修正が必要）。
- 公式に展示が出る前（＝発走の十数分前より早い時間）は `exhibition:false` が返ります。
- 取得対象は公開データのみ。常識的なアクセス頻度で利用してください（アプリは予想ボタンを押した時だけ取得します）。
