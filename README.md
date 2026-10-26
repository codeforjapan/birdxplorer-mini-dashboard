# BirdXplorer Mini Dashboard

X（旧Twitter）のコミュニティノートを BirdXplorer 経由で継続収集し、LLM で内容ごとに分類して時系列で可視化する「事例（テーマ）モニタ」。特定のキーワード群・期間に絞って、災害・選挙・大型イベントなど事例ごとの周辺に流通する情報を観測する。1つのデプロイで複数の事例を動かすマルチテナント構成で、事例の設定は DB が持つ。このリポジトリに実データ・実運用の内容は含まない。

## 事例の追加

1つのデプロイ（1つの DB・1つの Blob ストア）で複数の事例を動かす。事例（災害・選挙など）は Neon の `tenants` テーブルの設定であり、**新しい事例のためにリポジトリをコピーしたりコードを書き換えたりしない**。

1. **事例の JSON を書く。** `tenants/examples/` の雛形（`disaster.example.json` / `election.example.json`）をコピーし、名称・監視期間・検索キーワード・LLM の主語・基準時刻・一次情報リンクなどを埋める。分類の判断基準は事例の型（`disaster` / `election`、`src/lib/tenant/presets.ts`）が既定値を持ち、必要なら `overrides` で上書きする。
2. **スクリプトで登録する。** `pnpm exec tsx --env-file=.env.local scripts/tenant-upsert.ts <file.json>`。検証・マイグレーション・DB への upsert・Blob への公開設定の書き出しまで行う。
3. **ドメインを追加する（手作業）。** Vercel プロジェクトに `{slug}.<親ドメイン>` を追加し、DNS に CNAME を登録する。
4. **表示を確認する。** ホスト名から事例が引かれる。登録の無いホストは 404。

初回の Vercel プロジェクト・Neon・Blob の用意、環境変数、終了の扱いは [`docs/tenant-runbook.md`](docs/tenant-runbook.md)。Searchlight 連携は任意で、`SEARCHLIGHT_*` を設定せず `searchlightTopicId` を `null` にすれば無効になる。

## 構成

```
BirdXplorer REST API
  └─ /api/cron/dispatch/{job}（Vercel cron。DB には触らず tenants/index.json から対象事例を選び、
       │                       事例ごとの /api/cron/{job}?tenant={slug} を呼ぶ）
  └─ /api/cron/ingest（事例ごと10分。dispatch が2分×5枠でずらして呼ぶ）
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
| `src/lib/tenant/` | 事例の型・設定の解決・ホスト名からの引き当て・公開設定の書き出し。`presets.ts` が型ごとの分類既定値 |
| `scripts/tenant-upsert.ts` | 事例の作成・更新スクリプト。雛形は `tenants/examples/` |
| `migrations/` | Postgres スキーマ。連番を古い順に適用した結果が正典（適用済みは `schema_migrations` に記録） |
| `src/lib/types.ts` | TypeScript 側の型定義。Blob に書く JSON の形はここが唯一の定義 |
| `src/lib/db.ts` | Neon クライアントとマイグレーション |
| `src/lib/store.ts` | ノート・クラスタの永続化、タイムライン集計、スナップショット書き出し |
| `src/lib/state.ts` | 重複排除・リトライキュー・ジョブ実行記録 |
| `src/lib/birdxplorer.ts` | BirdXplorer API クライアント（リトライ・スキーマ検証・匿名化） |
| `src/lib/llm/` | LLM パイプライン各ステージ。`contract.ts` が呼び出し側との境界 |
| `src/lib/clusters.ts` | クラスタIDの採番と alias 解決 |
| `src/lib/cron.ts` / `cron-dispatch.ts` | cron ハンドラの共通枠（認証・実行記録）と、事例への振り分け |
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
| `CRON_SELF_ORIGIN` | 本番のカスタムドメイン（dispatch が作業ルートを呼ぶ先） |
| `TENANT_PARENT_DOMAIN` / `TENANT_HOST_ALIASES` | 事例のホスト名の引き当て（`.env.example` 参照） |
| `SEARCHLIGHT_*`（任意） | Searchlight連携を使う場合のみ。未設定なら自動的に無効化される |

### ローカルでの UI 確認

実データがなくても `?mock=1` でモックデータを使った表示を確認できる（`NODE_ENV=production` では無効）。

### cron の手動実行

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/ingest?tenant=<slug>"
```

## 設計上の注意点（事例を始めるときに見直すこと）

以下は元の設計判断を踏まえた注意点。新しい事例を始める際は、それぞれ妥当かを再確認すること。

- **レポートは全自動生成で人手の検証を経ていない。** 公開する場合は「AI生成」であることを示す等の対応を検討する
- **匿名化は不完全になりうる。** 投稿者情報は保存しない設計だが、X ポストへのリンクを併記する場合は特定が可能になる。匿名化は速度制限にすぎないことを踏まえて運用方針を決める
- **BirdXplorer の本番エンドポイントは存在せず、`dev.` サブドメインに依存している。** 予告なき停止に備え、取得失敗時は前回データを配信し続ける設計になっている
- **`impressionCount` は初回取得時の値で固定される。** 評価状態を再取得する API に `post` が含まれないため

## データ出典

- [BirdXplorer](https://birdxplorer.code4japan.org/) — Code for Japan
- X コミュニティノート
