import { list, put } from "@vercel/blob";
import { env } from "./env";

/**
 * データ本体の置き場（公開読み取り）。
 *
 * 公開URLは store ID を含むため env では持たず、list() で解決する。
 * pathname は決定的にする（addRandomSuffix: false）ので、日次レポートの
 * 永続URLも安定する。
 */

export const PATH = {
  notes: "data/notes.json",
  timeline: "data/timeline.json",
  clusters: "data/clusters.json",
  crossPosts: "data/cross-posts.json",
  dailyReport: (isoDay: string) => `reports/daily/${isoDay}.md`,
  cumulativeReport: "reports/cumulative.md",
} as const;

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
export async function listDailyReports(): Promise<string[]> {
  const { blobs } = await list({ prefix: "reports/daily/", limit: 1000, token: token() });
  return blobs
    .map((b) => b.pathname.match(/reports\/daily\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort()
    .reverse();
}
