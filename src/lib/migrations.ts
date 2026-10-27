/**
 * migrate()（db.ts）から DB 接続と fs を切り離した純粋な部分。
 * 「どのファイルを流すか」「どう文に分けるか」は DB なしでテストできるようにここに置く。
 */

/**
 * 未適用のマイグレーションファイルを、ファイル名の辞書順で返す。
 * 順序は依存関係（006 は 001 のテーブルを前提にする等）を守るため必ず名前順にする。
 */
export function pendingMigrations(files: readonly string[], applied: ReadonlySet<string>): string[] {
  return files
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
}

/**
 * SQL ファイルを1文ずつに分ける。Neon の HTTP ドライバは1呼び出し1ステートメントのため。
 * コメント行（行頭が `--`）を除いてから `;` で単純に区切る。
 * ドル引用や文字列リテラル内の `;` を含むファイルは扱えない（db.ts の migrate() のコメント参照）。
 */
export function splitStatements(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
