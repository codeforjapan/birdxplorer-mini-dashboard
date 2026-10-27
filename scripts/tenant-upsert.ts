/**
 * 事例（テナント）の作成・更新スクリプト。
 *
 * 実行: pnpm exec tsx --env-file=.env.local scripts/tenant-upsert.ts tenants/examples/disaster.example.json
 *       [--topic-stopped-in-searchlight]
 *
 * JSON を検証 → マイグレーション → tenants テーブルへ upsert → Blob の公開設定と事例一覧を更新する。
 * 同じ slug を再実行すれば設定の更新になる（searchlight_stopped_at は topic の差し替えと終了日の延長でだけ消える）。
 * DATABASE_URL と BLOB_READ_WRITE_TOKEN が指す先に実際に書くので、対象環境を確認してから流すこと。
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { appTitleSchema, githubRepoSchema, httpUrlSchema } from "../src/lib/tenant/fields";
import { isValidSlug } from "../src/lib/tenant/slug";
import type { TenantRecord } from "../src/lib/tenant/types";

export type TenantInput = Omit<TenantRecord, "updatedAt" | "searchlightStoppedAt">;

/** "2026-02-30" のような実在しない日付を、形式だけの正規表現が通さないようにする */
function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

const nonEmpty = z.string().min(1);

const settingsSchema = z
  .object({
    slug: z.string().refine(isValidSlug, "slug が規則に合いません"),
    siteTitle: nonEmpty,
    siteDescription: nonEmpty,
    eyebrowLabel: nonEmpty,
    scheduleLabel: z.string(),
    monitorStartAt: z.number().int().positive(),
    monitorEndDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealDate, "実在しない日付です"),
    searchKeywords: z.array(nonEmpty).min(1),
    llmContextPhrase: nonEmpty,
    llmContextPhraseCompact: nonEmpty,
    llmContextPhraseShort: nonEmpty,
    keyMoments: z.array(z.object({ at: z.number(), markerLabel: z.string() }).strict()),
    keyMomentLabel: z.string(),
    keyMomentValue: z.string(),
    githubRepo: githubRepoSchema,
    appTitle: appTitleSchema,
    issuesUrl: httpUrlSchema,
    officialSourcesIntro: z.string(),
    officialSources: z.array(z.object({ label: nonEmpty, url: httpUrlSchema }).strict()),
    officialSourcesDisclaimer: z.string(),
    searchlightTopicId: z.string().min(1).nullable(),
  })
  .strict();

const overridesSchema = z
  .object({
    relevanceMode: z.enum(["score", "binary"]),
    relevanceThreshold: z.number(),
    binMinutes: z.number().int().positive(),
    taxonomy: z
      .object({
        searchTermExamples: z.string(),
        relevantExamples: z.string(),
        irrelevantExamples: z.string(),
        clusterNamingGoodExamples: z.string(),
        clusterNamingBadExamples: z.string(),
        clusterNamingGoodExampleSingle: z.string(),
        clusterNamingBadExampleSingle: z.string(),
        overMergeCounterExample: z.string(),
        namingNeutralityRule: z.string().nullable(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

const inputSchema = z
  .object({
    slug: z.string().refine(isValidSlug, "slug が規則に合いません"),
    type: z.enum(["disaster", "election"]),
    status: z.enum(["draft", "active", "ended"]),
    settings: settingsSchema,
    overrides: overridesSchema,
  })
  .strict()
  .refine((v) => v.slug === v.settings.slug, {
    message: "slug と settings.slug が一致しません",
    path: ["settings", "slug"],
  });

/** 純関数。外部入力（JSON）を検証して型付きの値にする。違反は ZodError。 */
export function parseTenantInput(raw: unknown): TenantInput {
  return inputSchema.parse(raw);
}

export const TOPIC_STOPPED_FLAG = "--topic-stopped-in-searchlight";

/**
 * 純関数。収集中かもしれない topic を設定から外そうとしていれば、拒否の理由を返す。
 * 外すと searchlight-stop の対象から消え（index の hasSearchlight / topic の差し替え）、旧 topic の
 * 収集＝課金を誰も止めなくなる。停止の記録（searchlight_stopped_at）があれば止まっているので通す。
 */
export function topicRemovalRefusal(
  existing: Pick<TenantRecord, "settings" | "searchlightStoppedAt"> | null,
  input: TenantInput,
  stoppedInSearchlight: boolean,
): string | null {
  if (existing === null) return null;
  const oldTopic = existing.settings.searchlightTopicId;
  if (oldTopic === null || oldTopic === input.settings.searchlightTopicId) return null;
  if (existing.searchlightStoppedAt !== null || stoppedInSearchlight) return null;
  return [
    `searchlightTopicId を ${oldTopic} から ${String(input.settings.searchlightTopicId)} に変えようとしていますが、`,
    "旧 topic の収集停止が記録されていません（searchlight_stopped_at が空）。このまま変えると旧 topic の収集＝課金が止まりません。",
    "終了日の翌日以降に searchlight-stop が停止を記録するのを待ってから流し直すか、",
    `Searchlight のコンソールで旧 topic の収集を止めたうえで ${TOPIC_STOPPED_FLAG} を付けて流し直してください。`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (file === undefined) {
    console.error(
      `使い方: pnpm exec tsx --env-file=.env.local scripts/tenant-upsert.ts <file.json> [${TOPIC_STOPPED_FLAG}]`,
    );
    process.exit(1);
  }
  const input = parseTenantInput(JSON.parse(readFileSync(file, "utf8")));

  // DB・Blob を使うモジュールは、検証が通ってから読み込む（テストや検証だけの実行で接続を要求しない）
  const { migrate } = await import("../src/lib/db");
  const { getTenant, upsertTenant } = await import("../src/lib/tenant/repo");
  const { publishTenant } = await import("../src/lib/tenant/publish");

  await migrate();
  const refusal = topicRemovalRefusal(await getTenant(input.slug), input, args.includes(TOPIC_STOPPED_FLAG));
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }
  await upsertTenant(input);
  const saved = await getTenant(input.slug);
  if (saved === null) throw new Error(`upsert 後に事例が読めません: ${input.slug}`);
  try {
    await publishTenant(saved);
  } catch (e) {
    console.error("DB には反映済み・Blob は未反映。同じコマンドを再実行してください");
    console.error(e);
    process.exit(1);
  }
  console.log(`事例 ${saved.slug}（${saved.type} / ${saved.status}）を反映しました`);
}

// テストから import されたときは実行しない
if (process.argv[1]?.endsWith("tenant-upsert.ts")) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
