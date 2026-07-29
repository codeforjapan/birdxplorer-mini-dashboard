import { searchNotes } from "@/lib/birdxplorer";
import { runCronJob } from "@/lib/cron";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { CLASSIFIER_VERSION } from "@/lib/llm";
import { publishSnapshot, readClusters, readNotes, upsertClusters, upsertNotes } from "@/lib/store";
import type { Note } from "@/lib/types";
import { ensureMigrated } from "../../cron/_lib/migrate-once";
import { classifyBatch, type Candidate } from "../../cron/ingest/classify";

/**
 * Stage 1 のプロンプト改訂（CLASSIFIER_VERSION が上がったとき）に、既存ノートを
 * 新しい基準で再分類するための管理用エンドポイント。
 *
 * `ingest` とは別ジョブにする理由: ingest は「未取得の新規ノート」を対象に
 * cursor を前進させながら動く経路であり、既存の分類済み行を洗い直す用途とは
 * 目的も安全条件も異なる（cursor を触ってはいけない・rating 系カラムを触っては
 * いけない）。同じ関数に両方の分岐を持たせるより、専用エンドポイントに分けたほうが
 * 「何を触って何を触らないか」の条件が読みやすい。
 *
 * migrate() が node:fs に依存するため Edge Runtime では動かない（ingest/route.ts と同じ理由）。
 */
export const runtime = "nodejs";

/**
 * 1バッチが Stage1（25件区切り）→ Stage2（20件区切り）の2段 LLM 呼び出しを直列に行う。
 * 既定のバッチ上限（50件）でも Stage1 が2チャンク・Stage2 が3チャンク程度になり、
 * 各チャンクは chatJson 内部で最大45秒の壁時計予算を持つため、直列合計で最大
 * 数分かかり得る。ingest（300秒）と同じ上限を与え、365日運用の cron ではなく
 * 人間が手動で叩く管理エンドポイントなので、多少余裕を持たせても実害はない。
 */
export const maxDuration = 300;

// 1回の呼び出しで再分類するノート数の上限（既定値）。
// 105件全体を1回で処理しようとすると LLM チャンク数が伸びてタイムアウトのリスクが増えるため、
// 既定は控えめにし、呼び出し側が ?limit= で調整して複数回に分けて叩くことを前提にする。
const DEFAULT_BATCH_LIMIT = 50;
// 上限なしにすると1回のリクエストがいつまでも終わらないおそれがあるため、常に上限を設ける。
const MAX_BATCH_LIMIT = 200;

function parseLimit(req: Request): number {
  const raw = new URL(req.url).searchParams.get("limit");
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(Math.trunc(n), MAX_BATCH_LIMIT);
}

export async function POST(req: Request): Promise<Response> {
  return runCronJob("reclassify", req, async () => {
    await ensureMigrated();
    const limit = parseLimit(req);

    const stats = {
      remainingBefore: 0,
      selected: 0,
      reclassified: 0,
      included: 0,
      excluded: 0,
      missingPostText: 0,
      newClusters: 0,
      failed: 0,
    };

    // ── 対象件数を先に数える（診断・進捗確認用。この値自体は更新しない）──
    const countRows = await sql()`
      select count(*)::int as count from notes where classifier_version <> ${CLASSIFIER_VERSION}
    `;
    stats.remainingBefore = Number(countRows[0]?.count ?? 0);
    if (stats.remainingBefore === 0) return stats;

    // ── 対象ノートの選定 ──
    // classifier_version が現行と異なる行だけを選ぶ。再分類が終わった行は次回このクエリに
    // マッチしなくなるので、専用のカーソルを持たなくても「同じ呼び出しを繰り返せば
    // 取りこぼしなく・重複なく前進する」という再開可能性が自然に成り立つ。
    const rows = await sql()`
      select note_id, summary
      from notes
      where classifier_version <> ${CLASSIFIER_VERSION}
      order by note_id asc
      limit ${limit}
    `;
    const targetIds = rows.map((r) => String(r.note_id));
    stats.selected = targetIds.length;
    if (targetIds.length === 0) return stats;

    const targetIdSet = new Set(targetIds);
    const summaryByNoteId = new Map(rows.map((r) => [String(r.note_id), String(r.summary)]));

    // ── postText の再取得 ──
    // Postgres には post 本文を保存していない（CLAUDE.md「絶対に永続化しないもの」）ため、
    // 分類精度のために BirdXplorer API から取り直す。MONITOR_START_AT 以降の全件を1回で
    // 取得し、noteId でマッチングする（診断で summary のみだと relevance が下振れする
    // ノートがあることを確認済み）。SearchedNote.post は postId が非空でも null になり得るため、
    // その場合は postText: null のまま再分類する（呼び出し側での回避手段がない）。
    const { records } = await searchNotes({ from: env().MONITOR_START_AT });
    const postTextByNoteId = new Map(records.map((r) => [r.raw.noteId, r.postText]));

    // 対象ノートの完全な既存行を読み、分類系フィールドだけを差し替えて書き戻す。
    // readNotes() は全件読みだが、ingest のリトライ経路と同じ理由
    // （ID指定で数件だけ読む専用関数が無い・単一イベントモニタで規模が小さい）で許容する。
    const allNotes = await readNotes();
    const existingByNoteId = new Map(allNotes.filter((n) => targetIdSet.has(n.noteId)).map((n) => [n.noteId, n]));

    const candidates: Candidate[] = targetIds.map((noteId) => {
      const postText = postTextByNoteId.get(noteId) ?? null;
      if (postText === null) stats.missingPostText++;
      return {
        noteId,
        summary: summaryByNoteId.get(noteId) ?? existingByNoteId.get(noteId)?.summary ?? "",
        postText,
      };
    });

    // ── Stage1/2 を既存のバッチ分類パイプラインで実行 ──
    // ingest と同じ classifyBatch を通すことで、新規クラスタの採番（createCluster）や
    // 同名クラスタ提案の重複排除が ingest と完全に同一の挙動になる。
    const clusters = await readClusters();
    const result = await classifyBatch(clusters, candidates);
    stats.newClusters = result.newClusters.length;
    stats.failed = result.failedNoteIds.size;

    const updatedNotes: Note[] = [];
    for (const noteId of targetIds) {
      const classification = result.classifications.get(noteId);
      // 失敗ノートは classifier_version を据え置く。書き換えないので次回の呼び出しで
      // 同じ WHERE 句に再びマッチし、自然に再試行対象へ戻る（ingest の retry_queue とは
      // 別の、この管理エンドポイントに閉じた再開可能性の作り方）。
      if (!classification) continue;

      const existing = existingByNoteId.get(noteId);
      if (!existing) continue; // 理論上到達しない防御（selected は notes 由来のため必ず見つかる）

      // 分類系フィールド（relevance / excluded / excludeReason / clusterId / classifiedAt /
      // classifierVersion）だけを差し替える。評価系（currentStatus 等）は既存行のまま温存する
      // ── ここを touch すると refresh-status ジョブの管轄を侵すことになる。
      updatedNotes.push({ ...existing, ...classification });
      stats.reclassified++;
      if (classification.excluded) stats.excluded++;
      else stats.included++;
    }

    // クラスタ→ノートの順で書き込む（notes.cluster_id の外部キー制約のため。ingest と同じ順序）。
    await upsertClusters(result.newClusters);
    await upsertNotes(updatedNotes);

    // cursor（app_state の cursor:last_note_created_at）はここでは一切参照・更新しない。
    // このジョブは既存行の再分類であり、ingest が次に取得する範囲に影響してはならない。

    await publishSnapshot();

    return stats;
  });
}
