import { z } from "zod";
import { appTitleSchema, githubRepoSchema, httpUrlSchema } from "./fields";
import { isValidSlug } from "./slug";
import type { TenantRecord } from "./types";

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

export type SafeParseTenantInputResult =
  | { ok: true; value: TenantInput }
  | { ok: false; issues: { path: string; message: string }[] };

/** 画面用。例外にせず、違反を path（"settings.siteTitle" のドット連結）付きで返す。 */
export function safeParseTenantInput(raw: unknown): SafeParseTenantInputResult {
  const r = inputSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}
