import { bigintToNumber, parseJsonbMaybe, sql } from "./db";
import { env } from "./env";
import type { JobName, JobRun } from "./types";

/**
 * 削除された kv.ts の置き換え。責務は同じ（カーソル・重複排除・再試行キュー・
 * ジョブ実行記録）で、置き場所が Upstash Redis から Postgres の app_state /
 * retry_queue / job_runs テーブルに変わっただけ。
 * キー名は docs/spec.md §5.1 の命名をそのまま踏襲する。
 */

const CURSOR_KEY = "cursor:last_note_created_at";

// ── カーソル ─────────────────────────────────────────────────

/**
 * 最終処理済みノートの createdAt（epoch ms）。未設定なら MONITOR_START_AT。
 */
export async function getCursor(): Promise<number> {
  const rows = await sql()`select value from app_state where key = ${CURSOR_KEY}`;
  if (rows.length === 0) return env().MONITOR_START_AT;

  const parsed = parseJsonbMaybe(rows[0]?.value);
  if (typeof parsed !== "number") {
    throw new Error(`カーソルの値が不正です（number ではない）: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

/**
 * カーソルを進める。GREATEST で比較し、既存値より小さい at が来ても後退させない
 * （並行実行やリトライで古い at が渡されても巻き戻らないようにするため）。
 * 1文の INSERT ... ON CONFLICT として実行するので、この比較と更新自体が
 * 単一ステートメントの原子性でレースしない。
 */
export async function advanceCursor(at: number): Promise<void> {
  await sql()`
    insert into app_state (key, value, updated_at)
    values (${CURSOR_KEY}, to_jsonb(${at}::bigint), now())
    on conflict (key) do update set
      value = to_jsonb(greatest((app_state.value #>> '{}')::bigint, ${at}::bigint)),
      updated_at = now()
  `;
}

// ── 重複排除 ─────────────────────────────────────────────────

/**
 * 旧 `seen:note_ids`（KV の set）の置き換え。notes テーブルの主キーが
 * そのまま「見た/取り込んだ」の記録になるため、専用の集合を別途持つ必要がない。
 *
 * 分類に失敗したノートは意図的に notes に入れない（リトライキュー行きにする）ため、
 * ここで「未処理」と判定されて次回また取得対象になるのが正しい再試行経路。
 */
export async function filterUnseen(noteIds: readonly string[]): Promise<string[]> {
  if (noteIds.length === 0) return [];

  const rows = await sql()`select note_id from notes where note_id = any(${noteIds as string[]}::text[])`;
  const seen = new Set(rows.map((r) => String(r.note_id)));
  return noteIds.filter((id) => !seen.has(id));
}

// ── 再試行キュー ─────────────────────────────────────────────

export type RetryQueueEntry = {
  noteId: string;
  /** epoch ms */
  enqueuedAt: number;
  /** このノートで何回目の失敗か（1始まり）。 */
  attempts: number;
  reason: string | null;
};

type RetryQueueRow = {
  note_id: string;
  enqueued_at: string | number;
  attempts: number;
  reason: string | null;
};

function mapRetryRow(row: RetryQueueRow): RetryQueueEntry {
  return {
    noteId: row.note_id,
    enqueuedAt: bigintToNumber(row.enqueued_at),
    attempts: row.attempts,
    reason: row.reason,
  };
}

/**
 * 再試行キューに積む。同じ noteId が既にあれば attempts をインクリメントする
 * （2回目以降の分類失敗を重複行ではなく1行の再試行回数として記録するため）。
 */
export async function enqueueRetry(
  noteId: string,
  reason: string | null,
  now: number = Date.now(),
): Promise<void> {
  await sql()`
    insert into retry_queue (note_id, enqueued_at, attempts, reason)
    values (${noteId}, ${now}, 1, ${reason})
    on conflict (note_id) do update set
      attempts = retry_queue.attempts + 1,
      enqueued_at = excluded.enqueued_at,
      reason = excluded.reason
  `;
}

/**
 * 古い順に最大 limit 件を取り出し、キューから取り除く。
 * DELETE ... WHERE note_id IN (SELECT ... LIMIT n) は1つの SQL 文として原子的に
 * 実行されるため、複数 cron 実行が重なっても同じ行を二重に取り出すことはない。
 *
 * attempts の閾値による「諦め」判定はここではしない（呼び出し側が attempts を見て
 * 判断する）。すでにキューから外れた行を黙って捨てるのではなく、必ず戻り値として
 * 返すことで、呼び出し側が「恒久的に失敗しているノート」をログ等に残す機会を保つ。
 */
export async function drainRetryQueue(limit: number): Promise<RetryQueueEntry[]> {
  const rows = await sql()`
    delete from retry_queue
    where note_id in (
      select note_id from retry_queue order by enqueued_at asc limit ${limit}
    )
    returning note_id, enqueued_at, attempts, reason
  `;
  return rows.map((r) => mapRetryRow(r as unknown as RetryQueueRow));
}

export async function countRetryQueue(): Promise<number> {
  const rows = await sql()`select count(*)::int as count from retry_queue`;
  return Number(rows[0]?.count ?? 0);
}

// ── ジョブ実行記録 ───────────────────────────────────────────

type JobRunRow = {
  job: string;
  started_at: string | number;
  finished_at: string | number;
  ok: boolean;
  stats: unknown;
  error: string | null;
};

function mapJobRunRow(row: JobRunRow): JobRun {
  const stats = parseJsonbMaybe(row.stats);
  return {
    job: row.job,
    startedAt: bigintToNumber(row.started_at),
    finishedAt: bigintToNumber(row.finished_at),
    ok: row.ok,
    stats: (stats ?? {}) as Record<string, number>,
    error: row.error,
  };
}

/** job ごとに最新の実行結果だけを保持する（job が主キー）。 */
export async function recordRun(run: JobRun): Promise<void> {
  await sql()`
    insert into job_runs (job, started_at, finished_at, ok, stats, error)
    values (
      ${run.job},
      ${run.startedAt},
      ${run.finishedAt},
      ${run.ok},
      ${JSON.stringify(run.stats)}::jsonb,
      ${run.error}
    )
    on conflict (job) do update set
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      ok = excluded.ok,
      stats = excluded.stats,
      error = excluded.error
  `;
}

export async function getRun(job: JobName): Promise<JobRun | null> {
  const rows = await sql()`
    select job, started_at, finished_at, ok, stats, error
    from job_runs
    where job = ${job}
  `;
  if (rows.length === 0) return null;
  return mapJobRunRow(rows[0] as unknown as JobRunRow);
}
