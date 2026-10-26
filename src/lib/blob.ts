import { list, put } from "@vercel/blob";
import { env } from "./env";

/**
 * データ本体の置き場（公開読み取り）。
 *
 * 公開URLは store ID を含むため env では持たず、list() で解決する。
 * pathname は決定的にする（addRandomSuffix: false）ので、日次レポートの
 * 永続URLも安定する。
 */

/** 事例ごとの Blob パスの接頭辞に使える slug。パストラバーサルや大文字を弾く。 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

/**
 * 事例ごとの Blob パス。slug をそのままパスに埋め込むので、ここで形式を検証する
 * （`../x` のような値で他の事例や共有領域を指させないため）。
 */
export function tenantPaths(slug: string) {
  if (!SLUG_RE.test(slug)) throw new Error(`不正な slug です: ${JSON.stringify(slug)}`);
  const base = `tenants/${slug}`;
  return {
    notes: `${base}/data/notes.json`,
    timeline: `${base}/data/timeline.json`,
    clusters: `${base}/data/clusters.json`,
    crossPosts: `${base}/data/cross-posts.json`,
    dailyReport: (isoDay: string) => `${base}/reports/daily/${isoDay}.md`,
    cumulativeReport: `${base}/reports/cumulative.md`,
    config: `${base}/config.json`,
  };
}

/** 事例一覧（dispatch が DB を起こさず監視中の事例を知るための公開スナップショット）。 */
export const TENANT_INDEX_PATH = "tenants/index.json";

/**
 * put() の cacheControlMaxAge（秒）。@vercel/blob は既定で1ヶ月キャッシュするが、
 * それは「data/*.json を10分毎に上書きし、フロントは revalidate: 600 で読む」
 * この用途には長すぎる（CDN 側が古い応答を最大1ヶ月返し続けかねない）。
 *
 * - SNAPSHOT: notes/timeline/clusters（10分更新）と cumulative report（日次更新・
 *   ただし上書きされ得る）はどちらも「更新され得るファイル」なので、フロントの
 *   revalidate 間隔と揃えて600秒にする。
 * - IMMUTABLE: 日次ダイジェストは書き込み後に内容が変わらない（writeText の
 *   immutable オプションが再書き込み自体を拒否する）ので、長寿命キャッシュにしてよい。
 */
const SNAPSHOT_MAX_AGE = 600;
const IMMUTABLE_MAX_AGE = 60 * 60 * 24 * 365;

function token(): string {
  return env().BLOB_READ_WRITE_TOKEN;
}

async function resolveUrl(pathname: string): Promise<string | null> {
  const { blobs } = await list({ prefix: pathname, limit: 1000, token: token() });
  return blobs.find((b) => b.pathname === pathname)?.url ?? null;
}

type ReadOptions = {
  /**
   * ISR の再検証間隔（秒）。cron からの読み取りは常に最新が必要なので false を渡す。
   */
  revalidate?: number | false;
};

async function read(pathname: string, opts: ReadOptions = {}): Promise<string | null> {
  const url = await resolveUrl(pathname);
  if (!url) return null;

  const res = await fetch(
    url,
    opts.revalidate === false
      ? { cache: "no-store" }
      : { next: { revalidate: opts.revalidate ?? 600 } },
  );
  if (!res.ok) return null;
  return res.text();
}

/** 取得できない・壊れている場合は null。呼び出し側でフォールバックする。 */
export async function readJson<T>(pathname: string, opts?: ReadOptions): Promise<T | null> {
  const text = await read(pathname, opts);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function readText(pathname: string, opts?: ReadOptions): Promise<string | null> {
  return read(pathname, opts);
}

export async function writeJson(pathname: string, value: unknown): Promise<string> {
  const { url } = await put(pathname, JSON.stringify(value), {
    access: "public",
    contentType: "application/json; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: SNAPSHOT_MAX_AGE,
    token: token(),
  });
  return url;
}

export async function writeText(
  pathname: string,
  value: string,
  /** 日次ダイジェストは確定後に書き換えない。既存があれば上書きせず false を返す。 */
  opts: { immutable?: boolean } = {},
): Promise<string | false> {
  if (opts.immutable && (await resolveUrl(pathname))) return false;

  const { url } = await put(pathname, value, {
    access: "public",
    contentType: "text/markdown; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: !opts.immutable,
    cacheControlMaxAge: opts.immutable ? IMMUTABLE_MAX_AGE : SNAPSHOT_MAX_AGE,
    token: token(),
  });
  return url;
}

/** 日次ダイジェストの一覧（新しい順の "YYYY-MM-DD"）。アーカイブリンクの生成に使う。 */
export async function listDailyReports(slug: string): Promise<string[]> {
  // 接頭辞は tenantPaths 経由で作る（slug の検証を通し、他の事例の日次レポートを拾わない）
  const prefix = tenantPaths(slug).dailyReport("").replace(/\.md$/, "");
  const { blobs } = await list({ prefix, limit: 1000, token: token() });
  return blobs
    .map((b) => b.pathname.slice(prefix.length).match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort()
    .reverse();
}
