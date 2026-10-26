import { migrate } from "@/lib/db";

/**
 * migrate() を、この Lambda インスタンスが生きている間の最初の1回だけ実行する。
 *
 * migrate() は適用済みの移行ファイルを schema_migrations に記録して1回しか流さないが
 * （db.ts 参照）、記録の確認にも1往復かかる。cron 実行のたびに確認するのは無駄なので、
 * モジュールスコープの Promise でメモ化し、同一 Lambda 実行環境内のウォームリユース時は
 * 2回目以降ノーオペにする（db.ts の sql() のメモ化と同じ考え方）。
 *
 * 認証チェックより後（runCronJob の body 内）から呼ぶこと。こうすることで
 * 未認証リクエストが DATABASE_URL 未設定環境でも migrate() を叩いて無駄に落ちるのを防げる。
 */
let migratedPromise: Promise<void> | undefined;

export function ensureMigrated(): Promise<void> {
  migratedPromise ??= migrate().then(() => undefined);
  return migratedPromise;
}
