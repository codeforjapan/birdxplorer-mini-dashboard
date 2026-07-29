import { migrate } from "@/lib/db";

/**
 * migrate() を、この Lambda インスタンスが生きている間の最初の1回だけ実行する。
 *
 * migrate() 自体は移行ファイルを "create ... if not exists" 前提の冪等な内容にしているため
 * 何度呼んでも安全だが（db.ts 冒頭コメント参照）、cron 実行のたびに migrations/*.sql を
 * 読み直して毎回 CREATE TABLE を投げるのは無駄なラウンドトリップになる。
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
