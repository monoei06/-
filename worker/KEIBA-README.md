# 競馬データサーバー（Cloudflare Workers）デプロイ手順

中央競馬(JRA)には、ボートレースのような**無料の公式JSON API が存在しません**。
そこでこのフォルダの `keiba-proxy.js` が、netkeiba の公開ページ・オッズを取得して
**CORS 許可つき UTF-8 JSON** で返す小さなデータサーバー（プロキシ）になります。
これをデプロイしてアプリの ⚙️ に登録すると、本日の全レースと各レースのオッズ・出走表を
自動取得して予想できます。**Cloudflare の無料枠（1日10万リクエスト）で十分動きます。**

> 🚤 ボートレース用 `boatrace-proxy.js` と同じ手順です。すでにデプロイ経験があれば数分です。

---

## 方法A：ダッシュボードに貼り付け（最速・5分・PC/スマホ可）

1. https://dash.cloudflare.com/ にログイン（無料アカウント作成）
2. 左メニュー **Workers & Pages** →「**Create application**」→「**Create Worker**」
3. 名前を **`keiba`** にして「**Deploy**」
4. デプロイ後「**Edit code**」を開き、エディタの中身を**全部消して**、
   `keiba-proxy.js` の中身を**まるごと貼り付け**→「**Deploy**」
5. 画面に出る URL（例 `https://keiba.あなた.workers.dev`）をコピー
6. 競馬AI予想アプリ（`keiba.html`）の **⚙️データサーバー設定** にその URL を貼り付け

> 名前を `keiba` にして `https://keiba.<あなた>.workers.dev` になれば、アプリ既定の
> `DEFAULT_PROXY_URL` と一致するので、⚙️ への貼り付けすら不要になります（任意）。

---

## 方法B：Wrangler CLI（PC向け）

```bash
npm install -g wrangler
wrangler login
# このフォルダで:
wrangler deploy keiba-proxy.js --name keiba --compatibility-date 2024-11-01
```

---

## 動作確認

ブラウザで次を開き、JSON が返れば成功です。

**本日の開催・レース一覧:**
```
https://keiba.あなた.workers.dev/?date=20260613
```
```jsonc
{
  "date": "20260613",
  "meetings": [
    { "place": "東京", "meeting": "3回 東京 3日目",
      "races": [ { "race_id":"202605030301", "race_no":1, "name":"3歳未勝利",
                   "post_time":"09:55", "course":"ダ1600m", "head_count":16 }, ... ] },
    ...
  ],
  "race_count": 35
}
```

**1レースの詳細（オッズ・出走馬）:**
```
https://keiba.あなた.workers.dev/?race_id=202602010111
```
```jsonc
{
  "place":"函館", "race_no":11, "name":"函館スプリントS", "course":"芝1200m",
  "has_odds": true,
  "horses": [
    { "num":3, "name":"レイピア", "jockey":"横山武", "sexage":"牡4",
      "win_odds":4.1, "place_min":1.4, "place_max":1.8, "popularity":1 }, ...
  ]
}
```

## パラメータ

| 名前 | 内容 | 例 |
| --- | --- | --- |
| `date` | 日付 YYYYMMDD（省略時=日本時間の本日） | `20260613` |
| `race_id` | netkeiba のレースID（12桁）。指定時はそのレース詳細を返す | `202602010111` |

`race_id` は `年(4) 場(2) 回(2) 日(2) R(2)`。場コードは 01札幌/02函館/03福島/04新潟/05東京/06中山/07中京/08京都/09阪神/10小倉。

## 注意

- netkeiba の HTML/JSON 構造が変わると解析が壊れる可能性があります（その場合は
  `parseShutuba` / `getDay` の正規表現を修正してください）。
- 取得対象は公開データのみ。常識的なアクセス頻度（予想ボタンを押した時だけ取得）で利用してください。
- 出走取消などでオッズの無い馬は、予想の確率計算から自動的に除外されます。
