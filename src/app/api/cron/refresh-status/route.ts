import { fetchNoteStatuses } from "@/lib/birdxplorer";
import { runCronJob } from "@/lib/cron";
import { sql } from "@/lib/db";
import { applyStatusRefresh, publishSnapshot } from "@/lib/store";
import { ensureMigrated } from "../_lib/migrate-once";

// migrate() が node:fs に依存するため（ingest/route.ts のコメント参照）。
export const runtime = "nodejs";

/**
 * LLM を使わない（docs/spec.md §4 Stage6）。BirdXplorer API との往復のみで、
 * fetchNoteStatuses が50件区切りのバッチを直列に叩く。対象ノートが多い日は
 * バッチ数が伸びる可能性があるため、ingest ほどではないが 10秒既定よりは十分長くする。
 */
export const maxDuration = 180;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Vercel cron は GET で発火するため GET が本体（ingest/route.ts の同じ注記を参照）。 */
export async function GET(req: Request): Promise<Response> {
  return runCronJob("refresh-status", req, async () => {
    await ensureMigrated();

    // 直近7日分のノートIDだけが要る。summary 等のフルマッピングは不要なので、
    // store.ts の readNotes()（全件・フル Note へのマッピング）は経由せず
    // note_id だけを直接クエリする。
    const since = Date.now() - SEVEN_DAYS_MS;
    const rows = await sql()`select note_id from notes where created_at >= ${since}`;
    const noteIds = rows.map((r) => String(r.note_id));

    if (noteIds.length === 0) {
      // 対象なし。Blob を無駄に書き換えない（内容は変わらないため publishSnapshot も不要）。
      return { targeted: 0, refreshed: 0 };
    }

    // currentStatus / helpfulCount / notHelpfulCount / rateCount のみを更新する。
    // impressionCount は /api/v1/data/notes のレスポンスに含まれないため更新できない
    // （docs/spec.md §9.1 #9）。分類結果（relevance / clusterId 等）はここでは一切触らない
    // — applyStatusRefresh が対象カラムを絞った UPDATE であることがその保証。
    const statuses = await fetchNoteStatuses(noteIds);
    await applyStatusRefresh(statuses);

    await publishSnapshot();

    return { targeted: noteIds.length, refreshed: statuses.length };
  });
}

/** 手動実行・デバッグ用。cron 発火は GET 側。 */
export const POST = GET;
