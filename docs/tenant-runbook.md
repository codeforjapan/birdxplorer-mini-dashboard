# 事例（テナント）運用手順書

1つのデプロイで複数の事例（災害・選挙など）を動かす。設計は `docs/superpowers/specs/2026-10-23-multi-tenant-dashboard-design.md`、仕様は `docs/spec.md`（v2 の改訂）。

## 0. 先に必須: 熊本プロジェクトの Git 連携を外す

**このブランチを `main` にマージする前に**、Vercel の既存プロジェクト `kumamoto-earthquake-dashboard` の Git 連携を外すこと（ユーザーが行う）。

- このプロジェクトは本リポジトリの `main` に紐づいており、`main` へのマージで熊本の本番 URL が自動でテナント化後のコードに置き換わる
- テナント化後のコードは新しい（空の）DB 専用で、既存の熊本 DB（`tenant_id` なし）には動かない。マージ前に外さないと熊本の本番が壊れる
- 手順: Vercel ダッシュボード → `kumamoto-earthquake-dashboard` → Settings → Git → **Disconnect**。外した後もプロジェクトと既存デプロイはそのまま残る
- 沖縄版は別リポジトリ（`okinawa-election-dashboard`）なので影響しない

## 1. テナント化アプリ用の Vercel プロジェクトを作る（初回のみ）

既存の熊本・沖縄プロジェクトには手を加えず、**新規**に作る。

1. **Vercel プロジェクト**: c4j チームで新規作成し、このリポジトリを接続する。Production ブランチは `main`
2. **Neon DB**: **新しい**DB を作る（Vercel Marketplace の Neon 統合、または neon.com）。既存の熊本・沖縄の DB は流用しない（`migrations/006_tenants.sql` は空の DB 専用で、既存行のある DB に流すと意図どおり失敗する）。プーラ側（ホスト名に `-pooler` を含む）の接続文字列を使う
3. **Blob ストア**: **新しい** Blob ストアを **public アクセス**で作る。アクセスモードは作成後に変えられず、private だと全ての書き出しが失敗する
4. **環境変数**（Production / Preview 両方。`.env.example` に説明あり）:

   | 変数 | 内容 |
   |---|---|
   | `DATABASE_URL` | 手順2の Neon 接続文字列 |
   | `BLOB_READ_WRITE_TOKEN` | 手順3の Blob ストアのトークン |
   | `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter。モデルは `google/gemini-2.5-flash-lite` |
   | `CRON_SECRET` | `openssl rand -hex 32` |
   | `CRON_SELF_ORIGIN` | **本番のカスタムドメイン**（例 `https://<事例ではない共通ホスト>`）。末尾スラッシュなし |
   | `TENANT_PARENT_DOMAIN` | 事例のサブドメインの親（`{slug}.<これ>`） |
   | `TENANT_HOST_ALIASES` | ホスト名 → slug の別名（JSON）。旧 `.vercel.app` やローカル用。不要なら未設定 |
   | `BIRDXPLORER_API_BASE` | 既定のままでよい |
   | `SEARCHLIGHT_BASE_URL` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_COMPANY_ID` | 任意。未設定なら Searchlight 連携は無効 |

   `CRON_SELF_ORIGIN` を本番ドメインにする理由: Deployment Protection が `all_except_custom_domains` のため、デプロイ固有 URL（`*.vercel.app`）への自己呼び出しは SSO で弾かれる。dispatch は事例ごとの作業ルートをこの origin 経由で呼ぶ。
5. **ドメイン**: `CRON_SELF_ORIGIN` に使うカスタムドメインをプロジェクトに追加しておく（手順は §3）
6. デプロイする。DB のスキーマは、cron 実行時と `tenant-upsert` 実行時の `migrate()` で作られる（`schema_migrations` に記録され1回だけ流れる）

## 2. 新しい事例を立ち上げる

コードの変更・デプロイは不要（ドメイン追加の手作業を除く）。

1. **JSON を書く**: `tenants/examples/disaster.example.json`（災害）または `election.example.json`（選挙）をコピーして編集する。形は `Omit<TenantRecord, "updatedAt" | "searchlightStoppedAt">`
   - `slug`: 小文字英数とハイフン、1〜42文字。サブドメインと Blob のパスに入る。`settings.slug` と一致させる
   - `type`: `disaster` / `election`。分類プロンプトと関連性判定の既定値が型で決まる
   - `status`: `draft`（作業中・収集しない）/ `active` / `ended`
   - `settings.monitorStartAt`: epoch ms。`monitorEndDate`: `YYYY-MM-DD`（JST）。この日いっぱいが監視中で、翌日 00:00 JST から終了
   - `settings.searchKeywords`: 1語以上。OR・部分一致のゆるい検索語で、無関係なノートは関連性判定で弾く
   - `settings.searchlightTopicId`: Searchlight を使うときだけ。コンソールで topic を作り、その ID を貼る。使わなければ `null`
   - `overrides`: 型の既定値の上書き（`relevanceMode` / `relevanceThreshold` / `binMinutes` / `taxonomy`）。空文字・空配列は「上書きしない」と同じ扱い
2. **スクリプトを流す**（対象の `DATABASE_URL` / `BLOB_READ_WRITE_TOKEN` に実際に書き込む。環境を確認すること）:

   ```bash
   pnpm exec tsx --env-file=.env.local scripts/tenant-upsert.ts tenants/examples/disaster.example.json
   ```

   検証 → `migrate()` → `tenants` に upsert → Blob の `tenants/{slug}/config.json` と `tenants/index.json` を更新、の順。同じ slug で流し直せば設定の更新になる。
3. **ドメインを追加する**（§3）
4. **表示を確認する**: `https://{slug}.<親ドメイン>/` を開く。登録の無いホストは 404 になる。`status` を `active` にすると、次の dispatch から収集が始まる（ingest は slug 順に5枠へ割り当てられ、最大10分で最初の実行が来る）

example の `kumamoto-example` / `okinawa-example` は雛形で、既存の熊本・沖縄の移行ではない。`searchlightTopicId` は `null`。

## 3. ドメインの追加（手作業）

管理画面から Vercel API は叩かない。人が行う。

1. Vercel → 新プロジェクト → Settings → Domains → `{slug}.<親ドメイン>` を追加
2. 親ドメインの DNS に、Vercel が表示する値で **CNAME**（`{slug}` → `cname.vercel-dns.com` など。画面の指示に従う）を登録する。DNS を管理しているのは誰かは親ドメインごとに確認する
3. 反映後に HTTPS で開けることを確認する

## 4. 事例の終了

- `monitorEndDate` の翌日 00:00 JST に自動で終了扱いになる。dispatch は対象にしなくなり、Neon も起こさない。Blob の最終状態がそのまま配信され続ける
- 早く止めたいときは JSON の `status` を `ended` にして §2 のスクリプトを流し直す
- Searchlight の収集停止は `searchlight-stop`（毎日）が事例単位で1度だけ行い、`searchlight_stopped_at` に記録する。upsert はこの値を上書きしない
- 終了後に Neon を止める場合も、公開ページは Blob だけで動く

## 5. 障害時の見方

- 1事例が失敗しても他は止まらない。dispatch のレスポンスに全事例の結果が並ぶ（`status !== 200` の事例がログに出る）
- dispatch 自体が 500: `tenants/index.json` が壊れている可能性。スクリプトを流し直すと全事例から作り直される
- 同じ事例の cron が動かない: `status` / `monitorEndDate` と、`tenants/index.json` の該当エントリを確認する
