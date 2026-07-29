import { toNote, searchNotes } from "@/lib/birdxplorer";
import { runCronJob } from "@/lib/cron";
import { CLASSIFIER_VERSION } from "@/lib/llm";
import { advanceCursor, drainRetryQueue, enqueueRetry, filterUnseen, getCursor } from "@/lib/state";
import { UNCLASSIFIED_AT, publishSnapshot, readClusters, readNotes, upsertClusters, upsertNotes } from "@/lib/store";
import type { Note } from "@/lib/types";
import { ensureMigrated } from "../_lib/migrate-once";
import { classifyBatch, type Candidate } from "./classify";

/**
 * migrate() は node:fs（migrations/*.sql の読み取り）に依存するため Edge Runtime では動かない。
 * 4ジョブとも同じ理由でこの宣言が要る（各ファイルで `export const runtime` を明示する
 * のが Next.js App Router の作法のため、共通化はしない）。
 */
export const runtime = "nodejs";

/**
 * 4ジョブの中で最も重い: ページング取得 + Stage1/Stage2 の2段 LLM 分類 + リトライ排出を
 * 1回の実行でこなす。各 LLM チャンク呼び出しは chatJson 内部で最大45秒の壁時計予算を持ち、
 * バックフィル対象(約97件)なら数チャンクで収まるが、将来ノート数が増えても
 * 10分間隔の cron 同士が重ならない範囲で余裕を持たせる。
 */
export const maxDuration = 300;

// limit=1000 x 10ページ。バックフィル対象(約97件)を大きく上回るページ数を確保しつつ、
// 万一大量のノートが積み上がっていても searchNotes の truncated フラグで安全に打ち切れる。
const MAX_SEARCH_PAGES = 10;
// 1回の cron 実行で再試行するノート数の上限。無制限にすると1回の実行がいつまでも終わらない。
const RETRY_DRAIN_LIMIT = 50;

/**
 * Vercel cron は登録した path を **GET** で叩く（メソッドの指定はできない）。
 * そのため GET が本体でなければ 405 になり、ジョブが一度も発火しない。
 * POST は手動実行・デバッグ用に同じ処理へ割り当てておく。
 */
export async function GET(req: Request): Promise<Response> {
  return runCronJob("ingest", req, async () => {
    await ensureMigrated();

    const stats = {
      fetched: 0,
      unseen: 0,
      classified: 0,
      excluded: 0,
      failed: 0,
      newClusters: 0,
      retried: 0,
      retryClassified: 0,
      retryFailed: 0,
      truncated: 0,
    };

    // ── 1. cursor 以降のノートを取得 ──
    const cursor = await getCursor();
    const { records, truncated } = await searchNotes({ from: cursor, maxPages: MAX_SEARCH_PAGES });
    stats.fetched = records.length;
    stats.truncated = truncated ? 1 : 0;

    // ── 2. noteId で重複排除 ──
    const unseenIds = new Set(await filterUnseen(records.map((r) => r.raw.noteId)));
    const unseen = records.filter((r) => unseenIds.has(r.raw.noteId));
    stats.unseen = unseen.length;

    const clusters = await readClusters();

    // ── 3-4. Stage1 関連性判定 → Stage2 クラスタ割当 ──
    const candidates: Candidate[] = unseen.map((r) => ({
      noteId: r.raw.noteId,
      summary: r.raw.summary,
      postText: r.postText,
    }));
    const mainResult = await classifyBatch(clusters, candidates);
    stats.newClusters += mainResult.newClusters.length;

    const mainNotes: Note[] = [];
    for (const r of unseen) {
      const classification = mainResult.classifications.get(r.raw.noteId);
      if (classification) {
        mainNotes.push(toNote(r.raw, classification));
        stats.classified++;
        if (classification.excluded) stats.excluded++;
        continue;
      }

      // 分類失敗 → 消さずに未分類プレースホルダーとして保存し、再試行キューへ積む
      // （docs/spec.md §4・store.ts の UNCLASSIFIED_AT 参照）。
      const reason = mainResult.failureReasons.get(r.raw.noteId) ?? "unknown";
      mainNotes.push(
        toNote(r.raw, {
          relevance: 0,
          excluded: true,
          excludeReason: `分類失敗（再試行待ち）: ${reason}`,
          clusterId: null,
          classifiedAt: UNCLASSIFIED_AT,
          classifierVersion: CLASSIFIER_VERSION,
        }),
      );
      await enqueueRetry(r.raw.noteId, reason);
      stats.failed++;
    }

    // クラスタ→ノートの順で書き込む（notes.cluster_id の外部キー制約のため）。
    await upsertClusters(mainResult.newClusters);
    await upsertNotes(mainNotes);

    // ── 6. cursor 前進 ──
    // 分類の成否に関わらず、実際に取得できた最新 createdAt まで進める（決定#2）。
    // 対象は unseen（新規分）ではなく records（重複を含む取得結果全体）にする。
    // 同一ミリ秒境界の重複は次回 from=同値 で再取得して filterUnseen が弾く設計であり、
    // ここで cursor を戻す必要はない。
    if (records.length > 0) {
      const newestFetchedAt = records.reduce((max, r) => Math.max(max, r.raw.createdAt), cursor);
      await advanceCursor(newestFetchedAt);
    }

    // ── 7. 再試行キューの排出 ──
    // postText は初回 ingest の時点でメモリ上からしか扱われず、永続化していない
    // （CLAUDE.md「絶対に永続化しないもの」）。したがってここでは null を渡すほかなく、
    // 初回分類よりわずかに精度が落ちる。post本文を保存しないという設計上の制約の
    // 許容できる帰結として受け入れる（決定#3）。
    const retryEntries = await drainRetryQueue(RETRY_DRAIN_LIMIT);
    stats.retried = retryEntries.length;

    if (retryEntries.length > 0) {
      // store.ts に「IDを指定して数件だけ読む」専用関数が無いため readNotes() で全件読む。
      // 単一イベントモニタでテーブル規模が小さいことを前提に許容する。
      const allNotes = await readNotes();
      const existingByNoteId = new Map(allNotes.map((n) => [n.noteId, n]));

      const retryCandidates: Candidate[] = [];
      for (const entry of retryEntries) {
        const existing = existingByNoteId.get(entry.noteId);
        // 分類失敗ノートは必ず先に notes へプレースホルダーとして挿入している設計なので
        // 通常は必ず見つかるはずだが、見つからない場合は静かにスキップする（再挿入する材料がない）。
        if (existing) retryCandidates.push({ noteId: existing.noteId, summary: existing.summary, postText: null });
      }

      const retryResult = await classifyBatch(clusters, retryCandidates);
      stats.newClusters += retryResult.newClusters.length;

      const retryNotes: Note[] = [];
      for (const candidate of retryCandidates) {
        const existing = existingByNoteId.get(candidate.noteId);
        if (!existing) continue;

        const classification = retryResult.classifications.get(candidate.noteId);
        if (classification) {
          // 分類系カラムだけを更新し、他の評価系カラム等は既存行をそのまま引き継ぐ。
          retryNotes.push({ ...existing, ...classification });
          stats.retryClassified++;
          if (classification.excluded) stats.excluded++;
        } else {
          // まだ失敗。プレースホルダー行（UNCLASSIFIED_AT のまま）は変更せず、再度キューへ戻す。
          const reason = retryResult.failureReasons.get(candidate.noteId) ?? null;
          await enqueueRetry(candidate.noteId, reason);
          stats.retryFailed++;
        }
      }

      await upsertClusters(retryResult.newClusters);
      await upsertNotes(retryNotes);
    }

    // ── 8. 公開スナップショットを書き出す ──
    await publishSnapshot();

    return stats;
  });
}

/** 手動実行・デバッグ用。cron 発火は GET 側。 */
export const POST = GET;
