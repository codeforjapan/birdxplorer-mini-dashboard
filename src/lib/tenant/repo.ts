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
  hostLabel: z.string(),
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
  const rows = await sql()`select * from tenants order by settings->>'hostLabel', slug`;
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
      updated_at = greatest(excluded.updated_at, tenants.updated_at + 1),
      searchlight_stopped_at = ${searchlightStoppedAtExpr("excluded.settings", "excluded.status")}`,
    [rec.slug, rec.type, rec.status, JSON.stringify(rec.settings), JSON.stringify(rec.overrides), Date.now()],
  );
}

export type SaveResult =
  | { result: "saved"; record: TenantRecord }
  | { result: "conflict" }
  | { result: "exists" }
  | { result: "label-taken" };

const HOST_LABEL_INDEX = "tenants_host_label_idx";

/** ホスト名ラベルの一意制約（007）に当たったか。neon と pg のどちらのエラーも code・constraint を持つ */
export function isHostLabelTaken(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, constraint } = e as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === HOST_LABEL_INDEX;
}

const savedColumnsSchema = z.object({
  updated_at: z.union([z.string(), z.number()]),
  searchlight_stopped_at: z.union([z.string(), z.number()]).nullable(),
});

// 保存後に読み直すと、その間の他の書き込みの updated_at を拾って競合検知をすり抜けるので、書いた行の値を返す
function savedRecord(input: TenantInput, rows: unknown[]): SaveResult {
  const cols = savedColumnsSchema.parse(rows[0]);
  return {
    result: "saved",
    record: {
      ...input,
      searchlightStoppedAt: nullableBigintToNumber(cols.searchlight_stopped_at),
      updatedAt: bigintToNumber(cols.updated_at),
    },
  };
}

/**
 * 画面からの保存。後勝ちで上書きしないよう、新規（null）は既存 slug を弾き、
 * 更新は開いた時点の updated_at と一致するときだけ書く。
 * updated_at は同一ミリ秒の連続保存でも一致し直さないよう、必ず前の値より大きくする。
 * ホスト名ラベルが他の事例と重なれば label-taken（何も書かない）。
 */
export async function saveTenant(input: TenantInput, expectedUpdatedAt: number | null): Promise<SaveResult> {
  try {
    return await writeTenant(input, expectedUpdatedAt);
  } catch (e) {
    if (isHostLabelTaken(e)) return { result: "label-taken" };
    throw e;
  }
}

async function writeTenant(input: TenantInput, expectedUpdatedAt: number | null): Promise<SaveResult> {
  const settings = JSON.stringify(input.settings);
  const overrides = JSON.stringify(input.overrides);
  if (expectedUpdatedAt === null) {
    const rows = await sql().query(
      `insert into tenants (slug, type, status, settings, overrides, updated_at)
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
      on conflict (slug) do nothing
      returning updated_at, searchlight_stopped_at`,
      [input.slug, input.type, input.status, settings, overrides, Date.now()],
    );
    return rows.length === 0 ? { result: "exists" } : savedRecord(input, rows);
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
    returning updated_at, searchlight_stopped_at`,
    [input.slug, input.type, input.status, settings, overrides, Date.now(), expectedUpdatedAt],
  );
  return rows.length === 0 ? { result: "conflict" } : savedRecord(input, rows);
}

export type TenantListItem =
  | { slug: string; record: TenantRecord }
  | { slug: string; record: null; error: string };

/** 1行でも壊れていると一覧全体が落ちて直せなくなるので、行ごとに読んで失敗は理由として返す */
export async function listTenantsLenient(): Promise<TenantListItem[]> {
  const rows = await sql()`select * from tenants order by settings->>'hostLabel', slug`;
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
    update tenants set searchlight_stopped_at = ${at}, updated_at = greatest(${Date.now()}::bigint, updated_at + 1)
    where slug = ${slug}`;
}

/** tenant_id を持つテーブル。外部キー（notes → clusters）の参照先を先に書き、消すときは逆順にする */
const TENANT_DATA_TABLES = [
  "clusters",
  "notes",
  "retry_queue",
  "job_runs",
  "app_state",
  "searchlight_insights",
  "searchlight_cross_posts",
] as const;

export type TenantDataCounts = Record<(typeof TENANT_DATA_TABLES)[number], number>;

export async function countTenantData(slug: string): Promise<TenantDataCounts> {
  const counts = {} as TenantDataCounts;
  for (const t of TENANT_DATA_TABLES) {
    const rows = await sql().query(`select count(*)::int as n from ${t} where tenant_id = $1`, [slug]);
    counts[t] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * 事例の slug を付け替える（1回のトランザクション）。新しい slug の行を作ってデータを写し、古い行を消す。
 * 外部キーが on update cascade ではないので update ではなく写して消す。
 * ホスト名ラベルは一意なので、写す間は新しい行から外し、古い行を消してから戻す。
 * 写してから消すまでの間に他の書き込みが入ると写し漏れたまま消えるので、関係するテーブルを書き込み禁止でロックし、
 * そのうえで事例が「下書き」かつ quietBefore より前から変わっていないことを確かめる（違えば全体を取り消す）。
 * ロック中は他の事例の書き込みも待たされるが、数千行を写すだけなので数秒で終わる。
 */
export async function rekeyTenant(oldSlug: string, newSlug: string, quietBefore: number): Promise<void> {
  const old = await getTenant(oldSlug);
  if (old === null) throw new Error(`事例 ${oldSlug} がありません`);

  const colRows = await sql().query(
    `select table_name, column_name from information_schema.columns
    where table_schema = current_schema() and table_name in (
      select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'tenant_id'
    )
    order by table_name, ordinal_position`,
  );
  const columns = new Map<string, string[]>();
  for (const r of colRows) {
    const t = String(r.table_name);
    columns.set(t, [...(columns.get(t) ?? []), String(r.column_name)]);
  }
  // 知らないテーブルが増えていたら、写し漏れて消すことになるので止める
  const unknown = [...columns.keys()].filter((t) => !(TENANT_DATA_TABLES as readonly string[]).includes(t));
  if (unknown.length > 0) throw new Error(`付け替えの対象外のテーブルに tenant_id があります: ${unknown.join(", ")}`);

  await sql().transaction((txn) => [
    txn.query(`lock table tenants, ${TENANT_DATA_TABLES.join(", ")} in exclusive mode`),
    // 条件に合わなければ 0 除算でトランザクションごと失敗させる
    txn.query(
      `select 1 / count(*) from tenants where slug = $1 and status = 'draft' and updated_at <= $2`,
      [oldSlug, quietBefore],
    ),
    txn.query(
      `insert into tenants (slug, type, status, settings, overrides, searchlight_stopped_at, updated_at)
      select $2::text, type, status, (settings - 'hostLabel') || jsonb_build_object('slug', $2::text), overrides,
        searchlight_stopped_at, updated_at
      from tenants where slug = $1`,
      [oldSlug, newSlug],
    ),
    ...TENANT_DATA_TABLES.map((t) => {
      const cols = columns.get(t) ?? [];
      const select = cols.map((c) => (c === "tenant_id" ? "$2::text" : quoteIdent(c))).join(", ");
      return txn.query(
        `insert into ${t} (${cols.map(quoteIdent).join(", ")}) select ${select} from ${t} where tenant_id = $1`,
        [oldSlug, newSlug],
      );
    }),
    ...[...TENANT_DATA_TABLES].reverse().map((t) => txn.query(`delete from ${t} where tenant_id = $1`, [oldSlug])),
    txn.query("delete from tenants where slug = $1", [oldSlug]),
    txn.query(`update tenants set settings = settings || jsonb_build_object('hostLabel', $2::text) where slug = $1`, [
      newSlug,
      old.settings.hostLabel,
    ]),
  ]);
}
