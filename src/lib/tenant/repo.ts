import { z } from "zod";
import { bigintToNumber, nullableBigintToNumber, parseJsonbMaybe, sql } from "../db";
import { appTitleSchema, githubRepoSchema, httpUrlSchema } from "./fields";
import type { TenantInput } from "./input";
import type { TenantOverrides, TenantRecord, TenantSettings } from "./types";

/**
 * tenants テーブルの読み書き。
 * settings / overrides は jsonb で、DB の中身は管理操作で書かれた外部入力に近いので、
 * 読み出し時に zod で検証してから型付きの値として返す。
 */

const keyMomentSchema = z.object({ at: z.number(), markerLabel: z.string() });
const officialSourceSchema = z.object({ label: z.string(), url: httpUrlSchema });

const settingsSchema: z.ZodType<TenantSettings> = z.object({
  slug: z.string(),
  siteTitle: z.string(),
  siteDescription: z.string(),
  eyebrowLabel: z.string(),
  scheduleLabel: z.string(),
  monitorStartAt: z.number(),
  monitorEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  searchKeywords: z.array(z.string()),
  llmContextPhrase: z.string(),
  llmContextPhraseCompact: z.string(),
  llmContextPhraseShort: z.string(),
  keyMoments: z.array(keyMomentSchema),
  keyMomentLabel: z.string(),
  keyMomentValue: z.string(),
  githubRepo: githubRepoSchema,
  appTitle: appTitleSchema,
  issuesUrl: httpUrlSchema,
  officialSourcesIntro: z.string(),
  officialSources: z.array(officialSourceSchema),
  officialSourcesDisclaimer: z.string(),
  searchlightTopicId: z.string().nullable(),
});

const taxonomyPartialSchema = z
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
  .partial();

const overridesSchema: z.ZodType<TenantOverrides> = z.object({
  relevanceMode: z.enum(["score", "binary"]).optional(),
  relevanceThreshold: z.number().optional(),
  binMinutes: z.number().optional(),
  taxonomy: taxonomyPartialSchema.optional(),
});

const rowSchema = z.object({
  slug: z.string(),
  type: z.enum(["disaster", "election"]),
  status: z.enum(["draft", "active", "ended"]),
  settings: z.unknown(),
  overrides: z.unknown(),
  searchlight_stopped_at: z.union([z.string(), z.number()]).nullable(),
  updated_at: z.union([z.string(), z.number()]),
});

function toRecord(raw: unknown): TenantRecord {
  const row = rowSchema.parse(raw);
  const settings = settingsSchema.parse(parseJsonbMaybe(row.settings));
  // slug は Blob のパスにもサブドメインにも入る。食い違ったまま読むと別の事例の場所に書きかねない
  if (settings.slug !== row.slug) {
    throw new Error(`tenants.slug（${row.slug}）と settings.slug（${settings.slug}）が一致しません`);
  }
  return {
    slug: row.slug,
    type: row.type,
    status: row.status,
    settings,
    overrides: overridesSchema.parse(parseJsonbMaybe(row.overrides)),
    searchlightStoppedAt: nullableBigintToNumber(row.searchlight_stopped_at),
    updatedAt: bigintToNumber(row.updated_at),
  };
}

export async function getTenant(slug: string): Promise<TenantRecord | null> {
  const rows = await sql()`select * from tenants where slug = ${slug}`;
  return rows[0] === undefined ? null : toRecord(rows[0]);
}

export async function listTenants(): Promise<TenantRecord[]> {
  const rows = await sql()`select * from tenants order by slug`;
  return rows.map(toRecord);
}

// upsertTenant と saveTenant で条件が食い違うと停止記録の消え方が変わるので、式を1か所に置く
function searchlightStoppedAtExpr(newSettings: string, newStatus: string): string {
  return `case
        when (tenants.settings->>'searchlightTopicId') is distinct from (${newSettings}->>'searchlightTopicId')
          or (${newSettings}->>'monitorEndDate') > (tenants.settings->>'monitorEndDate')
          or (tenants.status = 'ended' and ${newStatus} <> 'ended')
        then null
        else tenants.searchlight_stopped_at
      end`;
}

/**
 * 設定を作成または更新する。searchlight_stopped_at は原則上書きしない
 * （終了処理の記録であり、設定編集で消えると Searchlight を二重に止める／止め忘れる）。
 * ただし topic を差し替えたとき、終了日を延ばしたとき、ended から戻したときは消す。前者は新しい topic を
 * まだ止めておらず、後の2つは再開した収集を次の終了時にまた止める必要があるため。
 */
export async function upsertTenant(rec: TenantInput): Promise<void> {
  await sql().query(
    `insert into tenants (slug, type, status, settings, overrides, updated_at)
    values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
    on conflict (slug) do update set
      type = excluded.type,
      status = excluded.status,
      settings = excluded.settings,
      overrides = excluded.overrides,
      updated_at = excluded.updated_at,
      searchlight_stopped_at = ${searchlightStoppedAtExpr("excluded.settings", "excluded.status")}`,
    [rec.slug, rec.type, rec.status, JSON.stringify(rec.settings), JSON.stringify(rec.overrides), Date.now()],
  );
}

export type SaveResult = "saved" | "conflict" | "exists";

/**
 * 画面からの保存。後勝ちで上書きしないよう、新規（null）は既存 slug を弾き、
 * 更新は開いた時点の updated_at と一致するときだけ書く。
 * updated_at は同一ミリ秒の連続保存でも一致し直さないよう、必ず前の値より大きくする。
 */
export async function saveTenant(input: TenantInput, expectedUpdatedAt: number | null): Promise<SaveResult> {
  const settings = JSON.stringify(input.settings);
  const overrides = JSON.stringify(input.overrides);
  if (expectedUpdatedAt === null) {
    const rows = await sql().query(
      `insert into tenants (slug, type, status, settings, overrides, updated_at)
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
      on conflict (slug) do nothing
      returning slug`,
      [input.slug, input.type, input.status, settings, overrides, Date.now()],
    );
    return rows.length === 0 ? "exists" : "saved";
  }
  const rows = await sql().query(
    `update tenants set
      type = $2,
      status = $3,
      settings = $4::jsonb,
      overrides = $5::jsonb,
      updated_at = greatest($6::bigint, updated_at + 1),
      searchlight_stopped_at = ${searchlightStoppedAtExpr("$4::jsonb", "$3")}
    where slug = $1 and updated_at = $7
    returning slug`,
    [input.slug, input.type, input.status, settings, overrides, Date.now(), expectedUpdatedAt],
  );
  return rows.length === 0 ? "conflict" : "saved";
}

export type TenantListItem =
  | { slug: string; record: TenantRecord }
  | { slug: string; record: null; error: string };

/** 1行でも壊れていると一覧全体が落ちて直せなくなるので、行ごとに読んで失敗は理由として返す */
export async function listTenantsLenient(): Promise<TenantListItem[]> {
  const rows = await sql()`select * from tenants order by slug`;
  return rows.map((row): TenantListItem => {
    const slug = String((row as { slug?: unknown }).slug);
    try {
      return { slug, record: toRecord(row) };
    } catch (err) {
      return { slug, record: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export async function markSearchlightStopped(slug: string, at: number): Promise<void> {
  await sql()`
    update tenants set searchlight_stopped_at = ${at}, updated_at = ${Date.now()}
    where slug = ${slug}`;
}
