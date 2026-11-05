import { z } from "zod";
import { readTextStrict, TENANT_INDEX_PATH, tenantPaths, writeJson } from "../blob";
import { isValidHostLabel } from "./slug";
import { listTenants } from "./repo";
import { resolveTenantConfig, toPublicConfig } from "./resolve";
import type { PublicTenantConfig, TenantRecord, TenantStatus } from "./types";

/**
 * 事例の設定を Blob に書き出す。DB が真実で、ここに書くのは公開ページと dispatch が
 * DB を起こさずに読むためのスナップショット。
 */

export type TenantIndexEntry = {
  slug: string;
  hostLabel: string;
  status: TenantStatus;
  monitorStartAt: number;
  monitorEndDate: string;
  hasSearchlight: boolean;
  searchlightStopped: boolean;
};

/**
 * index.json の CDN キャッシュ（秒）。Blob の下限の60秒にする。
 * 既定の600秒だと、状態を変えた事例が最大10分 dispatch に古いまま扱われる。
 */
const INDEX_MAX_AGE = 60;

const statusSchema = z.enum(["draft", "active", "ended"]);

const indexSchema = z.array(
  z
    .object({
      slug: z.string(),
      // 007 より前に書かれた index.json には無い。007 が既存の事例を slug と同じ値で埋めるのと揃える
      hostLabel: z.string().optional(),
      status: statusSchema,
      monitorStartAt: z.number(),
      monitorEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      hasSearchlight: z.boolean(),
      searchlightStopped: z.boolean(),
    })
    .transform(({ hostLabel, ...e }): TenantIndexEntry => ({ ...e, hostLabel: hostLabel ?? e.slug })),
);

const publicConfigSchema: z.ZodType<PublicTenantConfig> = z.object({
  slug: z.string(),
  siteTitle: z.string(),
  siteDescription: z.string(),
  eyebrowLabel: z.string(),
  scheduleLabel: z.string(),
  monitorStartAt: z.number(),
  monitorEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  keyMoments: z.array(z.object({ at: z.number(), markerLabel: z.string() })),
  keyMomentLabel: z.string(),
  keyMomentValue: z.string(),
  issuesUrl: z.string(),
  officialSourcesIntro: z.string(),
  officialSources: z.array(z.object({ label: z.string(), url: z.string() })),
  officialSourcesDisclaimer: z.string(),
  binMinutes: z.number(),
  status: statusSchema,
  hasSearchlight: z.boolean(),
});

function toIndexEntry(rec: TenantRecord): TenantIndexEntry {
  return {
    slug: rec.slug,
    hostLabel: rec.settings.hostLabel,
    status: rec.status,
    monitorStartAt: rec.settings.monitorStartAt,
    monitorEndDate: rec.settings.monitorEndDate,
    hasSearchlight: rec.settings.searchlightTopicId !== null,
    searchlightStopped: rec.searchlightStoppedAt !== null,
  };
}

/**
 * 1事例の config.json を書き、index.json を全事例から作り直す。
 * index を差分更新しないのは、DB の一覧と食い違ったまま残る経路を作らないため。
 */
export async function publishTenant(rec: TenantRecord): Promise<void> {
  await writeJson(tenantPaths(rec.slug).config, toPublicConfig(resolveTenantConfig(rec)));
  const all = await listTenants();
  await writeJson(TENANT_INDEX_PATH, all.map(toIndexEntry), { maxAgeSeconds: INDEX_MAX_AGE });
}

/**
 * dispatch 用。毎回最新が要るので ISR キャッシュを通さない。
 * 無い・読めない・壊れているときは例外にする（空として扱うと全事例の cron が黙って止まる）。
 * publishTenant が必ず書くので、無いのは「まだ1件も tenant-upsert していない」か事故のどちらか。
 */
export async function readTenantIndex(): Promise<TenantIndexEntry[]> {
  const text = await readTextStrict(TENANT_INDEX_PATH, { revalidate: false });
  if (text === null) throw new Error(`${TENANT_INDEX_PATH} がありません（tenant-upsert を一度も流していない環境か）`);
  return indexSchema.parse(JSON.parse(text));
}

/**
 * 公開ページ用。ホスト名ラベルから slug を引く。index の CDN キャッシュと同じ60秒で再検証する
 * （ラベルを変えてから新しい URL が開くまでの遅れをそれ以上に延ばさないため）。
 * ラベルが無ければ null（404）。slug では探さない（あるラベルが別の事例の slug と同じとき取り違えるため）。
 * 読み取り失敗・破損は readPublicConfig と同じ理由で例外にする。
 */
export async function findSlugByHostLabel(label: string): Promise<string | null> {
  if (!isValidHostLabel(label)) return null;
  const text = await readTextStrict(TENANT_INDEX_PATH, { revalidate: INDEX_MAX_AGE });
  if (text === null) return null;
  const entry = indexSchema.parse(JSON.parse(text)).find((e) => e.hostLabel === label);
  return entry?.slug ?? null;
}

/**
 * 公開ページ用。slug はホスト名由来の外部入力なので、形式違反と「無い」は null（404）にする。
 * 読み取り失敗・中身の破損は例外にする。null だと 404 が ISR にキャッシュされ、一時的な障害で
 * 生成済みのページが消える。例外ならエラー扱いになり、前回生成したページが配信され続ける。
 */
export async function readPublicConfig(slug: string): Promise<PublicTenantConfig | null> {
  let path: string;
  try {
    path = tenantPaths(slug).config;
  } catch {
    return null;
  }
  const text = await readTextStrict(path, { revalidate: 600 });
  if (text === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error(`[tenant-config] ${path} が JSON として読めない`, e);
    throw e;
  }
  const parsed = publicConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`[tenant-config] ${path} が公開設定の形に合わない`, parsed.error.issues);
    throw new Error(`${path} が公開設定の形に合いません`);
  }
  return parsed.data;
}

/** 公開ページ用。ホスト名ラベルから事例を引いて公開設定を読む。どちらかが無ければ null（404） */
export async function readPublicTenant(
  label: string,
): Promise<{ slug: string; config: PublicTenantConfig } | null> {
  const slug = await findSlugByHostLabel(label);
  if (slug === null) return null;
  const config = await readPublicConfig(slug);
  return config === null ? null : { slug, config };
}
