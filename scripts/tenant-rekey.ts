/**
 * 事例の slug を採番した値に付け替える（slug を人が付けていた頃の事例を、採番方式に揃えるため）。
 * URL（ホスト名ラベル）は変わらない。
 *
 * 実行: pnpm exec tsx --env-file=.env.local scripts/tenant-rekey.ts <slug>                 確認だけ（何も書かない）
 *       pnpm exec tsx --env-file=.env.local scripts/tenant-rekey.ts <slug> --execute       付け替える
 *       pnpm exec tsx --env-file=.env.local scripts/tenant-rekey.ts <slug> --delete-old-blobs  古い Blob を消す
 *
 * 付け替える前に管理画面で事例を「下書き」にして、QUIET_MINUTES 分待つ（走っている cron が書き終わるのを待つ）。
 * 手順は docs/tenant-runbook.md §4。DATABASE_URL と BLOB_READ_WRITE_TOKEN が指す先に実際に書く。
 */
import { isTenantMonitoringEnded } from "../src/lib/tenant/resolve";
import type { TenantRecord } from "../src/lib/tenant/types";

/** cron の作業ルートの maxDuration（300秒）と index.json の CDN キャッシュ（60秒）を足して余裕を見た値 */
export const QUIET_MINUTES = 7;

/** 純関数。付け替えてよくなければ理由を返す */
export function rekeyRefusal(
  rec: Pick<TenantRecord, "status" | "updatedAt" | "settings" | "searchlightStoppedAt"> | null,
  now: number,
): string | null {
  if (rec === null) return "その slug の事例はありません";
  // searchlight-stop は下書きでも終了日を過ぎた事例を止めに来る。付け替えの最中に停止を記録されると記録が消える
  if (
    rec.settings.searchlightTopicId !== null &&
    rec.searchlightStoppedAt === null &&
    isTenantMonitoringEnded(rec.settings, now)
  ) {
    return "終了日を過ぎ、Searchlight の停止がまだ記録されていません。searchlight-stop（毎日 06:45 UTC）が記録するのを待ってから流してください";
  }
  if (rec.status !== "draft") {
    return "収集中・終了の事例は cron が書き込むので付け替えられません。管理画面で「下書き」にしてから流してください";
  }
  const waitMs = rec.updatedAt + QUIET_MINUTES * 60_000 - now;
  if (waitMs > 0) {
    return `下書きにしてから ${QUIET_MINUTES} 分経っていません（あと約 ${Math.ceil(waitMs / 60_000)} 分）。走っている cron が書き終わるのを待ってください`;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--"));
  if (slug === undefined) {
    console.error("使い方: scripts/tenant-rekey.ts <slug> [--execute | --delete-old-blobs]");
    process.exit(1);
  }

  const { migrate } = await import("../src/lib/db");
  const { countTenantData, getTenant, rekeyTenant } = await import("../src/lib/tenant/repo");
  const { copyTenantBlobs, deleteTenantBlobs } = await import("../src/lib/blob");
  const { publishTenant, readTenantIndex } = await import("../src/lib/tenant/publish");
  const { generateTenantId } = await import("../src/lib/tenant/slug");

  await migrate();
  const rec = await getTenant(slug);

  if (args.includes("--delete-old-blobs")) {
    if (rec !== null) {
      console.error(`事例 ${slug} はまだ DB にあります。付け替えが済んだ古い slug だけ消せます`);
      process.exit(1);
    }
    // 付け替え後の公開に失敗していると、公開ページはまだ古い slug の Blob を見ている
    if ((await readTenantIndex()).some((e) => e.slug === slug)) {
      console.error(`tenants/index.json がまだ ${slug} を指しています。管理画面で新しい事例を保存し直してから流してください`);
      process.exit(1);
    }
    const deleted = await deleteTenantBlobs(slug);
    console.log(`tenants/${slug}/ の Blob を ${deleted.length} 件消しました`);
    return;
  }

  const refusal = rekeyRefusal(rec, Date.now());
  if (rec === null || refusal !== null) {
    console.error(`${slug}: ${refusal}`);
    process.exit(1);
  }
  const before = await countTenantData(slug);
  console.log(`事例 ${slug}（URL ${rec.settings.hostLabel} / ${rec.status}）`);
  console.log("DB の行数:", before);

  if (!args.includes("--execute")) {
    console.log("確認だけで終わります。付け替えるには --execute を付けて流してください");
    return;
  }

  const newSlug = generateTenantId();
  // 途中で失敗したとき、写しかけの tenants/{newSlug}/ を後で消せるよう先に出す
  console.log(`新しい slug: ${newSlug}`);
  // Blob は写すだけで元を消さないので先にやる。DB の付け替えが失敗しても元の事例はそのまま動く
  const copied = await copyTenantBlobs(slug, newSlug);
  console.log(`Blob を ${copied.length} 件 tenants/${newSlug}/ に写しました`);
  await rekeyTenant(slug, newSlug, Date.now() - QUIET_MINUTES * 60_000);
  const after = await countTenantData(newSlug);
  const mismatched = Object.keys(before).filter(
    (t) => before[t as keyof typeof before] !== after[t as keyof typeof after],
  );
  if (mismatched.length > 0) {
    console.error("付け替え後の行数が合いません（DB は付け替え済み）:", { before, after });
    process.exit(1);
  }
  const moved = await getTenant(newSlug);
  if (moved === null) throw new Error(`付け替え後に事例が読めません: ${newSlug}`);
  try {
    await publishTenant(moved);
  } catch (e) {
    console.error("DB は付け替え済み・公開設定は未反映。管理画面で新しい事例を開いて保存し直してください");
    console.error(e);
    process.exit(1);
  }
  console.log(`${slug} → ${newSlug} に付け替えました。行数は一致しています`);
  console.log("次: 管理画面で状態を戻し、公開ページを確かめてから --delete-old-blobs で古い Blob を消してください");
}

// テストから import されたときは実行しない
if (process.argv[1]?.endsWith("tenant-rekey.ts")) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
