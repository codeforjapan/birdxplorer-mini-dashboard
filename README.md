# 熊本地震 誤情報モニタ

2026年7月28日の熊本地震に関する X（旧Twitter）コミュニティノートを継続収集し、LLM で内容ごとに分類して時系列で可視化する単一イベントモニタ。

**運用期間: 公開開始 〜 2026年8月31日。** 以降は cron が自動停止し、静的アーカイブとして残置される。

## 仕様

実装の判断はすべて以下の2文書に従う。コードと文書が食い違う場合は文書を改訂する。

- **[`docs/spec.md`](docs/spec.md)** — システム仕様。データフロー、API、LLMパイプライン、ストレージ、既知のリスク
- **[`docs/design.md`](docs/design.md)** — デザイン仕様。UI実装はこちらに準拠する

## 構成

```
BirdXplorer REST API
  └─ /api/cron/ingest (10分ごと)
       ├─ LLM① 関連性スコア判定（閾値60未満は excluded）
       ├─ LLM② 既存クラスタへ割当 or 新規提案
       ├─ Neon Postgres に保存
       └─ Blob へスナップショット書き出し

  └─ /api/cron/recluster       (毎時) LLM③ クラスタのマージ・リネーム
  └─ /api/cron/refresh-status  (毎時) 評価状態の再取得（LLM不使用）
  └─ /api/cron/report    (毎日15:00 JST) LLM④⑤ 日次ダイジェスト＋累積レポート

Frontend (ISR 600s) ← Blob の JSON / Markdown
```

- **Neon Postgres** がノート・クラスタ・状態すべての唯一の真実
- **Vercel Blob** は Postgres から書き出される公開用スナップショット。サーバ側から読み戻さない（上書きの CDN 伝播に最大60秒かかるため read-modify-write の土台にできない。詳細は `docs/spec.md` §5.3）
- **LLM** は OpenRouter 経由の `google/gemini-2.5-flash-lite`

### ディレクトリ

| パス | 役割 |
|---|---|
| `migrations/` | Postgres スキーマ。`001_init.sql` がデータ定義の正典 |
| `src/lib/types.ts` | TypeScript 側の型定義。Blob に書く JSON の形はここが唯一の定義 |
| `src/lib/db.ts` | Neon クライアントとマイグレーション |
| `src/lib/store.ts` | ノート・クラスタの永続化、タイムライン集計、スナップショット書き出し |
| `src/lib/state.ts` | カーソル・リトライキュー・ジョブ実行記録 |
| `src/lib/birdxplorer.ts` | BirdXplorer API クライアント（リトライ・スキーマ検証・匿名化） |
| `src/lib/llm/` | LLM パイプライン各ステージ。`contract.ts` が呼び出し側との境界 |
| `src/lib/clusters.ts` | クラスタIDの採番と alias 解決 |
| `src/lib/cron.ts` | cron ハンドラの共通枠（認証・運用期間判定・実行記録） |
| `src/app/api/cron/` | 4つの cron エンドポイント |
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

### ローカルでの UI 確認

実データがなくても `?mock=1` でモックデータを使った表示を確認できる（`NODE_ENV=production` では無効）。

### cron の手動実行

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/ingest
```

## 運用上の注意

このサイトは以下を意図的な設計判断として受容している。詳細は `docs/spec.md` §8 と `/policy` を参照。

- **レポートは全自動生成で人手の検証を経ていない。** 「AI生成」ラベルを常時表示する
- **匿名化は不完全。** 投稿者情報は保存しないが X ポストへのリンクを併記するため、1クリックで特定できる。匿名化は速度制限にすぎない
- **訂正・削除依頼の窓口を設置していない。** 誤分類やレポートの誤りを外部から指摘する経路がない
- **BirdXplorer の本番エンドポイントは存在せず、`dev.` サブドメインに依存している。** 予告なき停止に備え、取得失敗時は前回データを配信し続ける
- **`impressionCount` は初回取得時の値で固定される。** 評価状態を再取得する API に `post` が含まれないため（`docs/spec.md` §9.1 #9）

## データ出典

- [BirdXplorer](https://birdxplorer.code4japan.org/) — Code for Japan
- X コミュニティノート
