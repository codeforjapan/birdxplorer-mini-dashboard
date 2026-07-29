# 開発規約

## パッケージマネージャは pnpm

**`npx` は使わない。** `pnpm exec`（ローカル依存の実行）または `pnpm dlx`（一時実行）を使う。

```bash
pnpm exec tsc --noEmit      # ✅
pnpm build                  # ✅
pnpm dlx some-one-off-tool  # ✅
npx tsc --noEmit            # ❌
```

理由: `npx` は不足パッケージを暗黙にインストールして `package.json` / `pnpm-lock.yaml` を書き換えることがある。

依存の追加・削除は `pnpm add` / `pnpm remove` のみで行う。作業の副産物として `package.json` を変更しない。

## 仕様書が正典

- [`docs/spec.md`](docs/spec.md) — システム仕様
- [`docs/design.md`](docs/design.md) — デザイン仕様。UI はこれに準拠する

実装と文書が食い違ったら、どちらが正しいかを判断して**文書を改訂する**。黙って乖離させない。`docs/spec.md` §9.1 には API の実測挙動が OpenAPI の記述と異なる点をまとめてあり、そこでは**実測が優先**する。

## データ定義の在り処

| 対象 | 正典 |
|---|---|
| Postgres スキーマ | `migrations/001_init.sql` |
| TypeScript の型 | `src/lib/types.ts` |
| LLM 層との境界 | `src/lib/llm/contract.ts` |

Neon Postgres が唯一の真実。Vercel Blob はそこから書き出す公開スナップショットであり、**サーバ側から読み戻さない**（上書きの CDN 伝播に最大60秒かかる。`docs/spec.md` §5.3）。

## 絶対に永続化しないもの

BirdXplorer API のレスポンスのうち、以下は**保存してはならない**。

- `post.text` — 分類のためメモリ上でのみ扱い、処理後に破棄する
- `post.xUser.*` — 一切使わない
- `post.link` — 実測では投稿者の表示名を URL に含む（`/status/` の前が screenName ではなく表示名）ため匿名化方針に反する。`postUrl` は `postId` のみから `https://x.com/user/status/{postId}` として組み立てる（過去にこれを見落として104/105件の表示名が公開 Blob に漏洩した実例あり）

Vercel Blob は既定で公開読み取り可能なため、UI で非表示にするだけでは外部から取得できてしまう。`src/lib/birdxplorer.ts` の `toNote()` がこの規則の実施点であり、フィールドを明示列挙してスプレッドを使わないことで将来の上流フィールド追加が漏れないようにしている。

## スタイル

- コメントと UI テキストは日本語
- コメントは *why* を書く。*what* はコードが語る
- TypeScript strict。`any` を使わず、境界では `unknown` + 検証
