# BirdXplorer Mini Dashboard

X（旧Twitter）のコミュニティノートを BirdXplorer 経由で継続収集し、LLM で内容ごとに分類して時系列で可視化する「単一イベント（テーマ）モニタ」のテンプレート。特定のキーワード群・期間に絞って、災害・選挙・大型イベントなど1つのテーマの周辺に流通する情報を観測するために作られている。

このリポジトリ自体はテンプレートであり、実データ・実運用の内容は含まない。実際に使う際はテーマごとに新しいリポジトリを作り、以下の手順でカスタマイズする。

## テンプレートの使い方

1. **GitHubの「Use this template」から新しいリポジトリを作る。**
2. **`src/lib/event.ts` を書き換える。** サイト名・説明文・検索キーワード・観測期間の基準時刻（`occurredAt`）・フッターの一次情報リンク・GitHub Issues URL など、テーマ固有の識別子はすべてここに集約されている。値を差し替えるだけで反映される。
3. **`src/lib/llm/taxonomy.ts` を書き換える。** ここは値の差し替えでは済まない。「何が誤情報として問題になるか」「どんな噂の型があるか」といった分類プロンプトの判断基準・具体例そのものであり、テーマごとに人手で書き直す必要がある（分類精度に直結するため、実際にそのテーマ周辺でどんな種類の誤情報が流通するかを踏まえて記述する）。
4. **`src/lib/llm/*.ts` のプロンプト本文を確認する。** 3で書き直す判断基準以外にも、Stage 1〜5 の各プロンプトにはテーマの前提（例:「地震」という語彙）が埋め込まれている箇所がある。`event.ts` の値を参照するように書けている部分はそのままでよいが、プロンプトの構成自体を見直す必要がないかは目を通すこと。
5. **インフラを新規に用意する。**
   - Neon Postgres（`DATABASE_URL`）
   - Vercel Blob（`BLOB_READ_WRITE_TOKEN`。**public アクセスで作成**。後から変更不可）
   - Vercel プロジェクト（デプロイ先ドメイン）
   - `CRON_SECRET`（`openssl rand -hex 32`）
   - `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`
   - `MONITOR_START_AT` / `MONITOR_END_DATE` をテーマの観測期間に合わせて設定
6. **Searchlight連携は任意。** `SEARCHLIGHT_*` の4変数を設定しなければ自動的に無効化され、`vercel.json` の cron 設定を変更する必要はない。
7. **`docs/spec.md` / `docs/design.md` を新しいテーマに合わせて書き直す。** テンプレート時点ではまだ元の仕様書がそのまま残っているため、実運用に入る前に更新すること。実装と文書が食い違ったら文書を改訂する（`CLAUDE.md` 参照）。

## 構成

```
BirdXplorer REST API
  └─ /api/cron/ingest (10分ごと)
       ├─ note 本文 OR 投稿本文でキーワード検索し noteId で和集合を取得
       ├─ LLM① 関連性スコア判定（閾値未満は excluded）
       ├─ LLM② 既存クラスタへ割当 or 新規提案
       ├─ Neon Postgres に保存
       └─ Blob へスナップショット書き出し

  └─ /api/cron/recluster        (毎時) LLM③ クラスタのマージ・リネーム
  └─ /api/cron/refresh-status   (毎時) 評価状態の再取得（LLM不使用）
  └─ /api/cron/report           (毎日15:00 JST) LLM④⑤ 日次ダイジェスト＋累積レポート
  └─ /api/cron/searchlight-sync (任意。30分ごと) Searchlight insight の取り込み

Frontend (ISR 600s) ← Blob の JSON / Markdown
```

- **Neon Postgres** がノート・クラスタ・状態すべての唯一の真実
- **Vercel Blob** は Postgres から書き出される公開用スナップショット。サーバ側から読み戻さない（上書きの CDN 伝播に最大60秒かかるため read-modify-write の土台にできない）
- **LLM** は OpenRouter 経由（既定は `google/gemini-2.5-flash-lite`。`OPENROUTER_MODEL` で変更可）

### ディレクトリ

| パス | 役割 |
|---|---|
| `src/lib/event.ts` | テーマ固有の識別子（名称・日付・検索語・リンク等）。フォーク時にまず書き換える |
| `src/lib/llm/taxonomy.ts` | テーマ固有の分類判断基準・具体例。フォーク時に書き直す |
| `migrations/` | Postgres スキーマ。`001_init.sql` がデータ定義の正典 |
| `src/lib/types.ts` | TypeScript 側の型定義。Blob に書く JSON の形はここが唯一の定義 |
| `src/lib/db.ts` | Neon クライアントとマイグレーション |
| `src/lib/store.ts` | ノート・クラスタの永続化、タイムライン集計、スナップショット書き出し |
| `src/lib/state.ts` | 重複排除・リトライキュー・ジョブ実行記録 |
| `src/lib/birdxplorer.ts` | BirdXplorer API クライアント（リトライ・スキーマ検証・匿名化） |
| `src/lib/llm/` | LLM パイプライン各ステージ。`contract.ts` が呼び出し側との境界 |
| `src/lib/clusters.ts` | クラスタIDの採番と alias 解決 |
| `src/lib/cron.ts` | cron ハンドラの共通枠（認証・運用期間判定・実行記録） |
| `src/app/api/cron/` | cron エンドポイント |
| `src/app/` | 公開サイト |

## セットアップ

```bash
pnpm install
cp .env.example .env.local   # 値を埋める
pnpm dev
```

### 環境変数

`.env.example` に取得先を含めて記載してある。外部サービスの発行が必要なのは以下。

| 変数 | 取得先 |
|---|---|
| `DATABASE_URL` | Neon（`-pooler` を含む接続文字列を使う） |
| `OPENROUTER_API_KEY` | https://openrouter.ai/settings/keys |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob store（**public アクセスで作成**。後から変更不可） |
| `CRON_SECRET` | `openssl rand -hex 32` で生成 |
| `SEARCHLIGHT_*`（任意） | Searchlight連携を使う場合のみ。未設定なら自動的に無効化される |

### ローカルでの UI 確認

実データがなくても `?mock=1` でモックデータを使った表示を確認できる（`NODE_ENV=production` では無効）。

### cron の手動実行

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/ingest
```

## 設計上の注意点（フォーク時に見直すこと）

このテンプレートは元々特定のテーマ向けに作られた実装から抽出したものであり、以下は元の設計判断を踏まえた注意点。新しいテーマで運用する際は、それぞれ自分たちのテーマに照らして妥当かを再確認すること。

- **レポートは全自動生成で人手の検証を経ていない。** 公開する場合は「AI生成」であることを示す等の対応を検討する
- **匿名化は不完全になりうる。** 投稿者情報は保存しない設計だが、X ポストへのリンクを併記する場合は特定が可能になる。匿名化は速度制限にすぎないことを踏まえて運用方針を決める
- **BirdXplorer の本番エンドポイントは存在せず、`dev.` サブドメインに依存している。** 予告なき停止に備え、取得失敗時は前回データを配信し続ける設計になっている
- **`impressionCount` は初回取得時の値で固定される。** 評価状態を再取得する API に `post` が含まれないため

## データ出典

- [BirdXplorer](https://birdxplorer.code4japan.org/) — Code for Japan
- X コミュニティノート
