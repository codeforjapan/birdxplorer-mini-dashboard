import { z } from "zod";
import { readText, TENANT_INDEX_PATH, tenantPaths, writeJson } from "../blob";
import { listTenants } from "./repo";
import { resolveTenantConfig, toPublicConfig } from "./resolve";
import type { PublicTenantConfig, TenantRecord, TenantStatus } from "./types";

/**
 * 事例の設定を Blob に書き出す。DB が真実で、ここに書くのは公開ページと dispatch が
 * DB を起こさずに読むためのスナップショット。
 */

export type TenantIndexEntry = {
  slug: string;
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
  z.object({
    slug: z.string(),
    status: statusSchema,
    monitorStartAt: z.number(),
    monitorEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hasSearchlight: z.boolean(),
    searchlightStopped: z.boolean(),
  }),
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
 * 壊れているときは例外にする（空として扱うと全事例の cron が黙って止まる）。
 */
export async function readTenantIndex(): Promise<TenantIndexEntry[]> {
  const text = await readText(TENANT_INDEX_PATH, { revalidate: false });
  if (text === null) return [];
  return indexSchema.parse(JSON.parse(text));
}

/** 公開ページ用。slug はホスト名由来の外部入力なので、形式違反も「無い」として null にする。 */
export async function readPublicConfig(slug: string): Promise<PublicTenantConfig | null> {
  let path: string;
  try {
    path = tenantPaths(slug).config;
  } catch {
    return null;
  }
  const text = await readText(path, { revalidate: 600 });
  if (text === null) return null;
  try {
    const parsed = publicConfigSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
