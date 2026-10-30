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
   | `ADMIN_EMAILS` / `ADMIN_ORIGIN` / `AUTH_SECRET` / `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | 管理画面用。値の用意は §1.5 |

   `CRON_SELF_ORIGIN` を本番ドメインにする理由: Deployment Protection が `all_except_custom_domains` のため、デプロイ固有 URL（`*.vercel.app`）への自己呼び出しは SSO で弾かれる。dispatch は事例ごとの作業ルートをこの origin 経由で呼ぶ。
5. **ドメイン**: 親ドメインを用意する（§3。初回のみ）。`CRON_SELF_ORIGIN` には事例ではない共通ホストを使う
6. デプロイする。DB のスキーマは、cron 実行時と `tenant-upsert` 実行時の `migrate()` で作られる（`schema_migrations` に記録され1回だけ流れる）
7. **最初の事例を §2 で作るまで、dispatch は毎回 500 になる**。`tenants/index.json` は `tenant-upsert` が初めて書くもので、無い状態を「事例0件」とは扱わない（読めないのを空と扱うと、障害時に全事例の cron が黙って止まるため）。draft の事例を1件作れば止まる

## 1.5 管理画面の初期設定（初回のみ）

事例の作成・編集・状態の切り替えを行う画面（`/admin`）は Google ログインで守る。環境変数を入れて再デプロイするまで、管理画面はエラーページになる（公開サイトと cron には影響しない）。

1. **ログイン先を決める**: `ADMIN_ORIGIN` は管理画面にログインできる**唯一の origin**（例 `https://birdxplorer-mini-dashboard.vercel.app`。末尾スラッシュなし）。他のホスト（事例のサブドメインなど）で `/admin` を開くと `${ADMIN_ORIGIN}/admin` へ飛ばされる。サブドメインごとに OAuth のリダイレクト URI を登録しなくて済むようにするため
2. **Google の OAuth クライアントを作る**: Google Cloud Console → API とサービス → 認証情報 → OAuth クライアント ID → アプリケーションの種類は**ウェブアプリケーション**。**承認済みのリダイレクト URI** に `{ADMIN_ORIGIN}/api/auth/callback/google` を登録する（`ADMIN_ORIGIN` と一字一句そろえる）。OAuth 同意画面が未設定なら先に設定する。発行された「クライアント ID」と「クライアント シークレット」を控える
3. **環境変数を Vercel に入れる**（Production / Preview 両方）:

   | 変数 | 内容 |
   |---|---|
   | `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | 手順2のクライアント ID とシークレット |
   | `AUTH_SECRET` | セッション署名鍵。`openssl rand -base64 32` |
   | `ADMIN_ORIGIN` | 手順1の origin |
   | `ADMIN_EMAILS` | ログインを許すメールアドレス。カンマ区切り（前後の空白は無視・大文字小文字は区別しない）。**空・未設定なら誰もログインできない**。ドメインは限定しない |

4. **再デプロイする**: 環境変数はデプロイ時に読まれるので、入れただけでは反映されない
5. **確認する**: `{ADMIN_ORIGIN}/admin` を開き、`ADMIN_EMAILS` のアカウントで入れること。リストに無いアカウントは入れないこと

ログインできる人の変更は `ADMIN_EMAILS` を書き換えて再デプロイする。

## 2. 新しい事例を立ち上げる

コードの変更・デプロイ・ドメインの作業は不要（URL は親ドメインのワイルドカードで自動で引ける。§3）。**画面から行うのが基本**で、スクリプト（`tenant-upsert`）は予備と、画面から変えられないものの変更に使う（§2.2）。

### 2.1 画面から立ち上げる

1. `{ADMIN_ORIGIN}/admin` にログインし、`/admin/new`（事例を新規作成）のウィザードを進める。型（`disaster` / `election`）・名称・監視期間・検索キーワード・基準時刻・一次情報リンクなどを入れる。入力の検証はスクリプトと同じ（§2.2 の項目の規則がそのまま効く）
2. 保存すると**必ず `draft`**（収集しない・公開ページも 404）で作られる。slug は作成後に変えられない
3. **ドメインの作業は不要**: `https://{slug}.<親ドメイン>/` は §3 のワイルドカードでそのまま引ける
4. **表示を確認する**: §2.2 手順4 と同じ。`draft` のうちは手元の `?mock=1` で見た目を確かめられる
5. `/admin/{slug}` の状態スイッチで `active` にする（確認ダイアログが出る）。次の dispatch から収集が始まる

編集も `/admin/{slug}` の1画面で行う。

- slug と Searchlight の topic は**表示のみ**。変えられない（topic はスクリプトで変える。§2.2・§4）
- 状態（`draft` / `active` / `ended`）は状態スイッチだけで変える。6通りの切り替えがすべてでき、そのつど確認ダイアログが出る
- **設定を変えても、すでに分類済みのノートは再分類されない**。分類の基準（`overrides`・キーワードなど）を変えて既存ノートにも効かせたいときは、従来どおり `/api/admin/reclassify`（`CRON_SECRET` 付き）を実行する
- 同時編集は後勝ちにならない。開いてから他の人が保存していると「ほかの人が更新しました」と出て保存されない。開き直して最新の内容に直してから保存する
- 保存は DB への反映のあと Blob へ公開設定を書き出す。Blob の書き出しに失敗したときは画面にそう出る。もう一度保存すれば書き出しをやり直す（DB の反映は冪等）
- 画面が「この事例は読めない」と報告する行（旧仕様で入った行など）は、画面では直せない。スクリプトで直す（§4 末尾）。**読めない行が1つでもあると、他の事例を保存・状態切り替えしても公開側（`index.json`）に反映されない**（一覧の作り直しが失敗するため。再保存では直らない）。一覧の上と保存時のメッセージに該当 slug が出る
- 状態切り替えは保存済みの設定をそのまま書く。その設定が今の入力の検証を通らないときは切り替えず、編集画面で直して保存するよう案内が出る

### 2.2 スクリプトで立ち上げる（予備・topic の変更用）

画面が使えないとき、`searchlightTopicId` を変えるとき、画面で読めない行を直すときに使う。画面と同じ検証・同じ保存処理（DB への upsert と Blob への書き出し）を通る。

1. **JSON を書く**: `tenants/examples/disaster.example.json`（災害）または `election.example.json`（選挙）をコピーして編集する。形は `Omit<TenantRecord, "updatedAt" | "searchlightStoppedAt">`
   - `slug`: 小文字英数とハイフン、1〜42文字。サブドメインと Blob のパスに入る。`settings.slug` と一致させる
   - `type`: `disaster` / `election`。分類プロンプトと関連性判定の既定値が型で決まる
   - `status`: `draft`（作業中・収集しない・公開ページも 404）/ `active` / `ended`
   - `settings.monitorStartAt`: epoch ms。`monitorEndDate`: `YYYY-MM-DD`（JST）。この日いっぱいが監視中で、翌日 00:00 JST から終了。開始日（JST）より前の日付は弾く
   - `settings.searchKeywords`: 1語以上。OR・部分一致のゆるい検索語で、無関係なノートは関連性判定で弾く
   - `settings.searchlightTopicId`: Searchlight を使うときだけ。コンソールで topic を作り、その ID を貼る。使わなければ `null`
   - `settings.appTitle`: 印字可能な ASCII だけ（OpenRouter に `X-Title` ヘッダとして送るため。日本語は不可）。`settings.githubRepo`: `owner/repo` の形。`settings.issuesUrl` と `officialSources[].url`: `http(s)://` の URL
   - `overrides`: 型の既定値の上書き（`relevanceMode` / `relevanceThreshold` / `binMinutes` / `taxonomy`）。空文字・空配列は「上書きしない」と同じ扱い

   > **注意: 型の既定 taxonomy は熊本・沖縄の文言のまま。** 災害型は熊本地震版（「熊本」「熊本関連」など）、選挙型は沖縄県知事選版（「沖縄」「知事」「辺野古移設」「普天間飛行場」「琉球」など）を出発点にしており、そのまま使うと別の事例の分類プロンプトに熊本・沖縄の地名や争点が混ざる。新しい事例では `overrides.taxonomy` で少なくとも次を上書きすること:
   >
   > | フィールド | 使われる場所 | 熊本・沖縄固有の部分の例 |
   > |---|---|---|
   > | `searchTermExamples` | 関連性判定（検索語の例） | 「熊本」「地震」「津波」／「沖縄」「知事」「琉球」 |
   > | `relevantExamples` | 関連性判定（残す例） | 「今回の熊本地震の文脈」／辺野古移設・普天間・沖縄戦 |
   > | `irrelevantExamples` | 関連性判定（除外する例） | 「熊本」が地名として入っているだけ／沖縄の観光・グルメ |
   > | `clusterNamingBadExamples` | クラスタ割当の命名（悪い例） | 「熊本関連」／「沖縄について」「知事選関連」 |
   > | `clusterNamingBadExampleSingle` | 再編成の rename（悪い例） | 「地震について」／「知事選について」 |
   >
   > 残りの `clusterNamingGoodExamples` / `clusterNamingGoodExampleSingle` / `overMergeCounterExample` / `namingNeutralityRule`（選挙型のみ）は地名を含まないが、事例のテーマに合っているかを見直すこと。指定しなかったフィールドは型の既定値のまま使われる。
   >
   > ```json
   > "overrides": {
   >   "taxonomy": {
   >     "searchTermExamples": "「能登」「地震」「津波」",
   >     "relevantExamples": "- 誤情報・デマの訂正（被害状況・津波・断水断電・義援金詐欺 など）\n- 訂正の形でなくても、今回の能登の地震に関する被害報告・安否・施設の状況",
   >     "irrelevantExamples": "- 地震と関係のない話題\n- 「能登」が地名として入っているだけの、地震と無関係な一般的話題",
   >     "clusterNamingBadExamples": "「地震について」「能登関連」",
   >     "clusterNamingBadExampleSingle": "地震について"
   >   }
   > }
   > ```

2. **スクリプトを流す**（対象の `DATABASE_URL` / `BLOB_READ_WRITE_TOKEN` に実際に書き込む。環境を確認すること）。`.env.local` には**テナント化アプリの Vercel プロジェクトの本番（Production）の** `DATABASE_URL` と `BLOB_READ_WRITE_TOKEN` が要る。プレビューや手元の値だと、本番から見えない DB・Blob に事例を作ってしまう:

   ```bash
   vercel env pull --environment=production .env.local   # 新プロジェクトに link した状態で
   pnpm exec tsx --env-file=.env.local scripts/tenant-upsert.ts tenants/examples/disaster.example.json
   ```

   検証 → `migrate()` → `tenants` に upsert → Blob の `tenants/{slug}/config.json` と `tenants/index.json` を更新、の順。同じ slug で流し直せば設定の更新になる。
   Blob の更新で失敗すると「DB には反映済み・Blob は未反映」と出て終了コード 1 になる。同じコマンドをそのまま流し直せばよい（upsert も書き出しも冪等）。
3. **ドメインの作業は不要**: `https://{slug}.<親ドメイン>/` は §3 のワイルドカードでそのまま引ける
4. **表示を確認する**: `https://{slug}.<親ドメイン>/` を開く。登録の無いホストと `draft` の事例は 404 になる（作業中の事例を公開しないため）。`draft` のうちは手元の `pnpm dev` で `?mock=1` を付ければ、その事例の設定とモックデータで見た目を確認できる。`status` を `active` にすると、次の dispatch から収集が始まる（ingest は slug 順に5枠へ割り当てられ、最大10分で最初の実行が来る）

   > **既知のリスク（ingest の枠ずれ）**: 枠は「監視中の事例を slug 順に並べたときの位置」で決まる。事例が監視を始める・終えると、それより後ろの事例の位置がずれて枠が変わり、その切り替わりの回に**同じ事例の ingest が約2分間隔で2回**走ることがある（1回の ingest が2分を超えると2本が重なる）。書き込みは upsert なので行は重複しないが、BirdXplorer API への重い検索と LLM 分類が一時的に二重に走り得る。事例の開始・終了はなるべく他事例の負荷が低い時間帯に行う

example の `kumamoto-example` / `okinawa-example` は雛形で、既存の熊本・沖縄の移行ではない。`searchlightTopicId` は `null`。

## 3. 親ドメインの準備（初回のみ）

事例の URL は `{slug}.<親ドメイン>`。親ドメインにワイルドカード（`*.<親ドメイン>`）を一度設定しておけば、事例を作るたびのドメイン追加・DNS 登録は要らない。管理画面から Vercel API や DNS は触らない。人が行う。

DNS を Vercel に移さずに済む方式（Vercel の「Use wildcard domains with an external DNS provider」）を使う。Vercel はワイルドカード証明書の発行に DNS での確認が要るため、`_acme-challenge` だけを Vercel に委任する。

試験環境の実例（2026-10-30）: 親ドメイン `cninfo.code4japan.org`。`code4japan.org` は別アカウントの Route53、`cninfo` のゾーンは birdxplorer アカウントの Route53（`Z03682931381VIRHELQTH`）。

1. **親ドメインのゾーンを作る**（例 Route53）: `aws route53 create-hosted-zone --name <親ドメイン> --caller-reference <一意な文字列>`。返ってきた4つのネームサーバーを控える
2. **上位のゾーンから委任する**: 上位（例 `code4japan.org`）のゾーンに、`<親ドメイン>` の **NS** レコードとして手順1の4つを登録する。上位のゾーンを管理している人に依頼する。`dig NS <親ドメイン> @8.8.8.8` で4つが返れば反映済み
3. **Vercel にワイルドカードを追加する**: プロジェクト → Settings → Domains → `*.<親ドメイン>`。上位ドメインがすでにチームで所有確認済みなら追加の TXT は要らない。未確認なら Vercel の指示どおり `_vercel.<上位ドメイン>` に TXT を足す
4. **親ドメインのゾーンにレコードを2つ入れる**:

   | 名前 | 種類 | 値 |
   |---|---|---|
   | `*.<親ドメイン>` | CNAME | Vercel の Domains 画面（または `GET /v6/domains/*.<親ドメイン>/config` の `recommendedCNAME` の1位）に出るプロジェクト固有の値（例 `2d6fbc5533e5eb58.vercel-dns-016.com`） |
   | `_acme-challenge.<親ドメイン>` | NS | `ns1.vercel-dns.com` と `ns2.vercel-dns.com` |

   `_acme-challenge` の NS は証明書の自動更新に使うので消さない
5. **環境変数** `TENANT_PARENT_DOMAIN=<親ドメイン>` を入れて再デプロイする
6. **確認する**: Vercel の Domains 画面でエラーが消えていること、既存の事例の `https://{slug}.<親ドメイン>/` が HTTPS で開けること

登録の無いサブドメインは「This page could not be found」を表示する（HTTP 200 の soft 404。既知の残課題）。

## 4. 事例の終了

- `monitorEndDate` の翌日 00:00 JST に自動で終了扱いになる。dispatch は対象にしなくなり、Neon も起こさない。Blob の最終状態がそのまま配信され続ける
- 早く止めたいときは `/admin/{slug}` の状態スイッチで `ended` にする（スクリプトなら JSON の `status` を `ended` にして §2.2 を流し直す）。cron はその時点（`tenants/index.json` の反映後）で止まる。ただし公開ページの「監視終了」表示は `monitorEndDate` だけを見ており `status` を見ないので、`ended` にしても終了日を過ぎるまでは監視中の表示のまま。表示も終了にしたいときは `monitorEndDate` も合わせて変える（終了日の翌日 00:00 JST から表示されるので、すぐ出したいなら前日の日付、翌日からでよければ当日の日付。表示される終了日もこの値になる）
- Searchlight の収集停止は `searchlight-stop`（毎日）が事例単位で1度だけ行い、`searchlight_stopped_at` に記録する。upsert はこの値を原則上書きしないが、`searchlightTopicId` を変えたとき、`monitorEndDate` を後ろに延ばしたとき、`status` を `ended` から戻したときは消す（新しい topic・再開した収集を、次の終了時にまた止めるため）
- **再開しても Searchlight の収集は自動では戻らない**。`ended` から戻す・終了日を延ばすなどで事例を再開するときは、`searchlight-stop` が無効にした topic の収集を Searchlight のコンソールで手で有効に戻す。戻さないと `searchlight-sync` は成功し続けるが取り込みは 0 件のまま
- topic が一覧に無い・`collectionConfig` があるのに形が読めない・topic があるのに `SEARCHLIGHT_*` が未設定のときは、`searchlight-stop` / `searchlight-sync` は失敗（500・`job_runs.ok=false`）になり、停止済みとは記録しない。毎日失敗し続けるので、原因を直すまで残る。`collectionConfig` 自体が無い topic は自動収集を設定していないものとして、止める対象なしで停止済みと記録する
- **`searchlightTopicId` は画面から変えられない**。外す・差し替えるのはスクリプトで行う。**停止の記録が無いまま外す・差し替えることはスクリプトが拒否する**（外すと `searchlight-stop` の対象から消え、旧 topic の収集＝課金を誰も止めなくなる）。終了日の翌日以降に `searchlight-stop` が停止を記録するのを待ってから流し直すか、Searchlight のコンソールで旧 topic の収集を止めたうえで `--topic-stopped-in-searchlight` を付けて流す。旧 topic ID が誤記で Searchlight のトピック一覧に無い場合も、`searchlight-stop` は停止を記録できず待っても解消しないので、`--topic-stopped-in-searchlight` を付けて差し替える
- 既存の行が今の検証を通らず読めない（旧仕様で入った行など。画面もその事例を読めないと報告する）ときも、旧 topic を判定できないのでスクリプトは拒否する。Searchlight のコンソールで旧 topic の収集が止まっていることを確かめたうえで `--topic-stopped-in-searchlight` を付けて流すと、行を上書きして直す
- 終了後に Neon を止める場合も、公開ページは Blob だけで動く

## 5. 障害時の見方

- 1事例が失敗しても他は止まらない。dispatch のレスポンスに全事例の結果が並び、1件でも `status !== 200` があれば dispatch 自体が 502 を返す（失敗した事例はその応答が返った時点で1件ずつログに出る）
- dispatch 自体が 500: `tenants/index.json` が無い・読めない・壊れている。無いのは事例を1件も作っていない環境（§1 手順7）。それ以外はスクリプトを流し直すと全事例から作り直される
- 公開ページがエラーになる: `tenants/{slug}/config.json` が読めないか壊れている（ログに `[tenant-config]` で中身の違反箇所が出る）。404 にしないのは、一時的な障害で 404 がキャッシュされて生成済みのページが消えるのを防ぐため。スクリプトを流し直すと書き直される
- 特定のホストだけ 404: `TENANT_PARENT_DOMAIN` / `TENANT_HOST_ALIASES` の不備は、インスタンスごとに1回 `[tenant-host]` でログに出る
- 同じ事例の cron が動かない: `status` / `monitorEndDate` と、`tenants/index.json` の該当エントリを確認する
