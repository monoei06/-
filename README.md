# 🚤 ボートレース予想アプリ

[Boatrace Open API](https://boatraceopenapi.github.io/) の本日の出走表データを使い、
ブラウザだけで動く（バックエンド不要の）ボートレース自動予想 Web アプリです。
スマホでもそのまま使え、ホーム画面に追加すればアプリのように起動できます（PWA対応）。

## 特長

- **インストール不要** — URL を開くだけ。スマホ／PC 両対応のレスポンシブUI。
- **本日のレースを自動取得** — 開催中の全24場・各レースの出走表をリアルタイム取得。
- **独自スコアリング予想** — コース有利度・全国/当地勝率・平均ST・モーター・級別・F/L を
  重み付けして各艇のスコアと勝率（％）を算出。◎○▲△の印を自動表示。
- **買い目を自動提案** — 3連単（本命／抑え）・3連複BOX・2連単をワンタップで表示。
- **PWA** — ホーム画面に追加してフルスクリーンのアプリとして利用可能。

## 使い方

1. 公開 URL（GitHub Pages）をスマホ／PCのブラウザで開く
2. 「会場」と「レース」を選ぶ
3. 「予想する」をタップ

## 公開方法（GitHub Pages）

このリポジトリには Pages 自動デプロイ用のワークフロー（`.github/workflows/deploy.yml`）が含まれています。

- 対象ブランチ（`claude/zen-hawking-0ed2tx` または `main`）に push すると自動でビルド・公開されます。
- 初回は GitHub の **Settings → Pages → Build and deployment → Source** を **「GitHub Actions」** に設定してください
  （ワークフロー側でも `enablement: true` により自動有効化を試みます）。
- 公開 URL は `https://<ユーザー名>.github.io/<リポジトリ名>/` です。

## 仕組み

| 指標 | 内容 | 重み |
| --- | --- | --- |
| コース | 進入コース別の全国平均1着率（イン有利を反映） | 0.30 |
| 全国2連対率 | `racer_national_top_2_percent` | 0.22 |
| 全国勝率 | `racer_national_top_1_percent` | 0.12 |
| 当地2連対率 | `racer_local_top_2_percent` | 0.10 |
| 平均ST | `racer_average_start_timing`（低いほど高評価） | 0.10 |
| モーター2連対率 | `racer_assigned_motor_top_2_percent` | 0.10 |
| 級別 | A1/A2/B1/B2 | 0.06 |

F（フライング）・L（出遅れ）回数は減点。スコアは softmax で勝率（％）に変換しています。
重みは `app.js` の `WEIGHTS` で調整できます。

## 注意

本アプリの予想は公開データに基づく自動計算であり、的中を保証するものではありません。
舟券の購入は自己責任で行ってください。**20歳未満は舟券を購入できません。**

データ提供: [Boatrace Open API](https://boatraceopenapi.github.io/)
