import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { env } from "./env";
import { pendingMigrations, splitStatements } from "./migrations";

/**
 * Neon Postgres クライアント。
 *
 * `neon()`（HTTP ドライバ）を使う。cron 1回の実行はクエリを数回投げて終わる
 * 短命な処理であり、Pool（WebSocket/TCP を維持するドライバ）のようにコネクションを
 * 張り続ける必要がない。サーバーレス関数はリクエストの度にプロセスが入れ替わり得るため、
 * 素の HTTP リクエストとして完結する neon() のほうが相性がよい。
 *
 * モジュールスコープでメモ化する（同一の Lambda 実行環境内でのウォームリユースのため）。
 * 接続文字列自体が変わることはない前提。
 */
let sqlCache: NeonQueryFunction<false, false> | undefined;

export function sql(): NeonQueryFunction<false, false> {
  sqlCache ??= neon(env().DATABASE_URL);
  return sqlCache;
}

/**
 * コールドスタートについて。
 * Neon の無料枠は約5分アイドルで自動サスペンドするため、10分間隔の cron は
 * 実質毎回コールドスタートに当たる。HTTP ドライバではこれは「初回クエリの
 * レイテンシが伸びる」だけで、接続エラーにはならない（Neon のプロキシ側が
 * compute のウェイクアップを吸収してから応答を返す）。
 * そのためここではリトライを実装しない。リトライを足すと、本当の障害
 * （認証切れ・スキーマ不整合等）もコールドスタートと区別できずに隠してしまう。
 * fetch にも短いタイムアウトを明示的に設定しない — ウェイクアップ待ちの間に
 * こちらから打ち切ってしまうと、コールドスタートを失敗として扱うのと同じことになる。
 * 呼び出し側（Vercel の関数タイムアウト）が唯一の上限となる。
 */

/**
 * Postgres の bigint 列はドライバ上で文字列として返ってくる（JS の number は
 * 53bit までしか安全に表現できないため、ドライバは精度を落とさない安全側に倒している）。
 * このアプリで bigint に入っているのは epoch ミリ秒だけで、その値は
 * Number.MAX_SAFE_INTEGER（2^53-1 ≈ 9007199254740991、西暦285428年相当）を
 * 大きく下回る。したがって number へ変換して安全に扱える。
 * 変換はこの関数1箇所に閉じ込める。「精度が心配だから BigInt に戻す」修正は不要。
 */
export function bigintToNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function nullableBigintToNumber(value: string | number | null): number | null {
  return value === null ? null : bigintToNumber(value);
}

/**
 * jsonb 列は多くの場合ドライバが自動で JSON.parse 済みの値を返すが、
 * 環境やバージョンによって文字列のまま返る場合に備えて両対応にしておく。
 */
export function parseJsonbMaybe(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * migrations/*.sql を古い順（ファイル名の辞書順）に適用する。
 *
 * 適用済みのファイルは `schema_migrations` に記録し、次回以降は飛ばす。
 * 以前は全ファイルを毎回流し、各ファイルが冪等であることに頼っていた。しかし 006 のように
 * 主キーやインデックスを付け替えるファイルは、冪等に書けても関数のコールドスタートの度に
 * 再作成することになり（ロックと負荷）、記録で1回きりにする。
 * 各ファイルは引き続き冪等に書く（記録の insert 前に落ちた場合の再試行と、
 * 並行したコールドスタートが同じファイルを流す場合に備える）。
 *
 * Neon の HTTP ドライバは1回の呼び出しにつき1ステートメントが基本（tagged template /
 * query() はどちらも単一ステートメント用）。ファイル内の複数ステートメントを
 * 1回のラウンドトリップで送るために `transaction()` の関数形式
 * （txn => [...]）を使う — これは「非対話的トランザクション」であり、
 * 各クエリが前のクエリの結果を参照する必要はないため、この用途にちょうど合う。
 * ファイル内のステートメントと適用済み記録の insert は同じトランザクションに入れる。
 * 途中で失敗すればファイル全体と記録がロールバックされ、次回また丸ごと再試行できる。
 *
 * 分割の仕様は splitStatements()（migrations.ts）を参照。
 */
export async function migrate(): Promise<{ files: string[] }> {
  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await sql().query(
    "create table if not exists schema_migrations (file text primary key, applied_at bigint not null)",
  );
  const rows = await sql().query("select file from schema_migrations");
  const applied = new Set(rows.map((r) => String(r.file)));

  for (const file of pendingMigrations(files, applied)) {
    const statements = splitStatements(readFileSync(join(dir, file), "utf8"));
    await sql().transaction((txn) => [
      ...statements.map((stmt) => txn.query(stmt)),
      txn.query(
        "insert into schema_migrations (file, applied_at) values ($1, $2) on conflict (file) do nothing",
        [file, Date.now()],
      ),
    ]);
  }

  return { files };
}
