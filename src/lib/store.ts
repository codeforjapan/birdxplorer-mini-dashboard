import { writeJson, PATH } from "./blob";
import { resolveClusterId } from "./clusters";
import { BIN_MINUTES } from "./constants";
import { bigintToNumber, nullableBigintToNumber, sql } from "./db";
import { env } from "./env";
import { binStart, nextBin } from "./time";
import type { Cluster, ClustersFile, Note, NotesFile, TimelineBin, TimelineFile } from "./types";
import type { NoteStatusRefresh } from "./birdxplorer";

/**
 * Postgres（Neon）上の永続データ層。
 *
 * Neon がノート・クラスタ・状態すべての唯一の真実であり、Vercel Blob は
 * publishSnapshot() が書き出すだけの一方向な公開スナップショットになった
 * （Blob は上書きの CDN 伝播に最大60秒かかるため read-modify-write の土台にはできない —
 * migrations/001_init.sql 冒頭コメント参照）。cron はここから読み戻さない。
 */

// ── 行 ⇔ 型のマッピング ──────────────────────────────────────
// bigint 列は文字列で返るため、境界のこの1箇所（db.ts の bigintToNumber）で
// number に変換する。他の場所で Number() / BigInt() を直書きしない。

type NoteRow = {
  note_id: string;
  post_id: string;
  created_at: string | number;
  summary: string;
  post_url: string;
  current_status: Note["currentStatus"];
  helpful_count: number;
  not_helpful_count: number;
  rate_count: number;
  impression_count: string | number | null;
  status_refreshed_at: string | number;
  relevance: number;
  excluded: boolean;
  exclude_reason: string | null;
  cluster_id: string | null;
  classified_at: string | number;
  classifier_version: string;
};

type ClusterRow = {
  id: string;
  name: string;
  description: string;
  color_index: number;
  created_at: string | number;
  alias_of: string | null;
};

function mapNoteRow(row: NoteRow): Note {
  return {
    noteId: row.note_id,
    postId: row.post_id,
    createdAt: bigintToNumber(row.created_at),
    summary: row.summary,
    postUrl: row.post_url,
    currentStatus: row.current_status,
    helpfulCount: row.helpful_count,
    notHelpfulCount: row.not_helpful_count,
    rateCount: row.rate_count,
    impressionCount: nullableBigintToNumber(row.impression_count),
    statusRefreshedAt: bigintToNumber(row.status_refreshed_at),
    relevance: row.relevance,
    excluded: row.excluded,
    excludeReason: row.exclude_reason,
    clusterId: row.cluster_id,
    classifiedAt: bigintToNumber(row.classified_at),
    classifierVersion: row.classifier_version,
  };
}

function mapClusterRow(row: ClusterRow): Cluster {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    colorIndex: row.color_index,
    createdAt: bigintToNumber(row.created_at),
    aliasOf: row.alias_of,
  };
}

// ── 読み取り ─────────────────────────────────────────────────

export async function readNotes(): Promise<Note[]> {
  const rows = await sql()`select * from notes order by created_at asc`;
  return rows.map((r) => mapNoteRow(r as unknown as NoteRow));
}

export async function readClusters(): Promise<Cluster[]> {
  const rows = await sql()`select * from clusters order by created_at asc`;
  return rows.map((r) => mapClusterRow(r as unknown as ClusterRow));
}

/**
 * publishSnapshot 用に notes と clusters を同一スナップショットから読む。
 * 別々の SELECT で読むと、その間に ingest が新しいクラスタとそれを参照する
 * ノートを挿入した場合、「clusters にはまだ無いのに notes 側だけ新しい」
 * ねじれが起きうる（resolveClusterId が解決できず、フロントに素の cluster_id が
 * 漏れる）。REPEATABLE READ の読み取り専用トランザクションで両方読むことで、
 * 常にどちらかの世代の一貫したペアになることを保証する。
 */
async function readSnapshot(): Promise<{ notes: Note[]; clusters: Cluster[] }> {
  const [clusterRows, noteRows] = await sql().transaction(
    (txn) => [txn`select * from clusters`, txn`select * from notes`],
    { isolationLevel: "RepeatableRead", readOnly: true },
  );
  return {
    clusters: clusterRows.map((r) => mapClusterRow(r as unknown as ClusterRow)),
    notes: noteRows.map((r) => mapNoteRow(r as unknown as NoteRow)),
  };
}

// ── 書き込み ─────────────────────────────────────────────────

/**
 * まだ分類していないことを表す番兵値。
 * 監視対象は2026年なので、本物の classifiedAt（epoch ms）は必ずこれより大きい。
 */
export const UNCLASSIFIED_AT = 0;

/**
 * クラスタを挿入・更新する。notes が cluster_id の外部キーを持つため、
 * 参照するノートより先にこちらを呼ぶ必要がある（呼び出し側の責務）。
 *
 * color_index と created_at は「採番後は変更しない」設計（migrations/001_init.sql,
 * src/lib/clusters.ts 参照）なので更新対象に含めない。name / description / alias_of
 * だけを更新できるようにする（再編成ジョブによるリネームやマージ操作のため）。
 *
 * バッチ全体を1つの非対話的トランザクションにまとめる。理由は正しさ（FK 順序）ではなく
 * 可視性: publishSnapshot() が読む Repeatable Read スナップショットに、
 * 「一部のクラスタだけ挿入されている」中途半端な状態を見せないため。
 */
export async function upsertClusters(clusters: readonly Cluster[]): Promise<void> {
  if (clusters.length === 0) return;

  await sql().transaction((txn) =>
    clusters.map((c) =>
      txn.query(
        `insert into clusters (id, name, description, color_index, created_at, alias_of)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set
           name = excluded.name,
           description = excluded.description,
           alias_of = excluded.alias_of`,
        [c.id, c.name, c.description, c.colorIndex, c.createdAt, c.aliasOf],
      ),
    ),
  );
}

/**
 * ノートを noteId で挿入・更新する。原則 incoming が勝つ（ingest cron が新規取得・
 * 再分類したノートで上書きする経路）。
 *
 * ただし incoming が「まだ分類していない」プレースホルダー（classifiedAt === UNCLASSIFIED_AT）
 * で、かつ既存行に本物の分類結果（classified_at <> 0）がある場合は、分類系カラム
 * （relevance / excluded / exclude_reason / cluster_id / classified_at / classifier_version）
 * だけ既存の値を温存する。LLM分類がまだ終わっていないノートを一旦保存する際に、
 * 既に分類済みの同じノートを巻き戻さないためのガード（旧 store.ts の upsertNotes と同じ意図）。
 * これを SQL 側の CASE 式として表現しているので、行を読み出してマージしてから
 * 書き戻す（read-modify-write）必要がない。
 *
 * 注意: `excluded` は notes テーブルの実カラム名であると同時に、
 * PostgreSQL の ON CONFLICT が公開する擬似テーブル名でもある。
 * `excluded.excluded` は「提案された（incoming の）excluded 列」、
 * `notes.excluded` は「更新前（既存）の excluded 列」を指す。紛らわしいが正しい構文。
 *
 * 評価状態（currentStatus 等）だけを更新したい場合はこの関数ではなく
 * applyStatusRefresh を使うこと（呼び出し側の意図を関数を分けることで示す）。
 *
 * upsertClusters と同じ理由でバッチ全体を1トランザクションにまとめる
 * （publishSnapshot に中途半端なバッチを見せないため）。
 */
export async function upsertNotes(notes: readonly Note[]): Promise<void> {
  if (notes.length === 0) return;

  const preserveWhenUnclassified = "excluded.classified_at = 0 and notes.classified_at <> 0";

  await sql().transaction((txn) =>
    notes.map((n) =>
      txn.query(
        `insert into notes (
           note_id, post_id, created_at, summary, post_url,
           current_status, helpful_count, not_helpful_count, rate_count, impression_count, status_refreshed_at,
           relevance, excluded, exclude_reason, cluster_id, classified_at, classifier_version
         )
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (note_id) do update set
           post_id = excluded.post_id,
           created_at = excluded.created_at,
           summary = excluded.summary,
           post_url = excluded.post_url,
           current_status = excluded.current_status,
           helpful_count = excluded.helpful_count,
           not_helpful_count = excluded.not_helpful_count,
           rate_count = excluded.rate_count,
           impression_count = excluded.impression_count,
           status_refreshed_at = excluded.status_refreshed_at,
           relevance = case when ${preserveWhenUnclassified} then notes.relevance else excluded.relevance end,
           excluded = case when ${preserveWhenUnclassified} then notes.excluded else excluded.excluded end,
           exclude_reason = case when ${preserveWhenUnclassified} then notes.exclude_reason else excluded.exclude_reason end,
           cluster_id = case when ${preserveWhenUnclassified} then notes.cluster_id else excluded.cluster_id end,
           classified_at = case when ${preserveWhenUnclassified} then notes.classified_at else excluded.classified_at end,
           classifier_version = case when ${preserveWhenUnclassified} then notes.classifier_version else excluded.classifier_version end`,
        [
          n.noteId,
          n.postId,
          n.createdAt,
          n.summary,
          n.postUrl,
          n.currentStatus,
          n.helpfulCount,
          n.notHelpfulCount,
          n.rateCount,
          n.impressionCount,
          n.statusRefreshedAt,
          n.relevance,
          n.excluded,
          n.excludeReason,
          n.clusterId,
          n.classifiedAt,
          n.classifierVersion,
        ],
      ),
    ),
  );
}

/**
 * Stage 6（評価状態リフレッシュ、docs/spec.md §4）。
 * 評価系カラムと status_refreshed_at だけを対象を絞った UPDATE で上書きする。
 * 分類結果は一切触らない（再分類はしない。impressionCount も /api/v1/data/notes
 * からは取得できないため更新しない — src/lib/birdxplorer.ts の NoteStatusRefresh の
 * 型コメント参照）。対象外（7日を超えた等で statuses に含まれない）noteId は
 * WHERE 句にマッチせず 0 行更新になるだけで、既存行はそのまま残る。
 *
 * バッチを1トランザクションにまとめる理由は upsertNotes と同じ
 * （publishSnapshot に半端な更新を見せないため）。
 */
export async function applyStatusRefresh(
  statuses: readonly NoteStatusRefresh[],
  now: number = Date.now(),
): Promise<void> {
  if (statuses.length === 0) return;

  await sql().transaction((txn) =>
    statuses.map((s) =>
      txn.query(
        `update notes set
           current_status = $2,
           helpful_count = $3,
           not_helpful_count = $4,
           rate_count = $5,
           status_refreshed_at = $6
         where note_id = $1`,
        [s.noteId, s.currentStatus, s.helpfulCount, s.notHelpfulCount, s.rateCount, now],
      ),
    ),
  );
}

// ── タイムライン集計 ──────────────────────────────────────────

const BIN_MS = BIN_MINUTES * 60 * 1000;
// 30分ビンで約114年分。データ異常（未来日時の混入等）で巨大配列を生成しないためのガード。
const MAX_BINS = 2_000_000;

/**
 * フロント表示用に30分ビンを事前集計する。永続層が Blob から Postgres に変わっても
 * この関数は入出力とも純粋なままにする（テストしやすさと、書き出し先を差し替える
 * だけで済むようにするため）。
 *
 * - 除外ノート（excluded: true）は集計しない
 * - clusterId は resolveClusterId で解決してから数える
 *   （クラスタはマージされ得るので、ノートは吸収済みの古いIDを持ち続ける）
 * - counts は解決後のIDでキーし、0件のクラスタはキーごと省く
 * - MONITOR_START_AT の属するビンから、最新ノートの属するビンまで、
 *   ノートが1件も無いビンも空けずに埋める（グラフのX軸を等間隔に保つため）
 * - startAt 昇順でソートして返す
 */
export function buildTimeline(notes: readonly Note[], clusters: readonly Cluster[], now: number = Date.now()): TimelineFile {
  const included = notes.filter((n) => !n.excluded);
  const start = binStart(env().MONITOR_START_AT);

  if (included.length === 0) {
    return {
      generatedAt: now,
      binMinutes: BIN_MINUTES,
      bins: [{ startAt: start, total: 0, counts: {} }],
    };
  }

  const newestCreatedAt = included.reduce((max, n) => Math.max(max, n.createdAt), included[0].createdAt);
  const end = binStart(newestCreatedAt);

  const binCount = Math.round((end - start) / BIN_MS) + 1;
  if (binCount < 1 || binCount > MAX_BINS) {
    throw new Error(`タイムラインのビン数が異常です (${binCount})。ノートの createdAt を確認してください。`);
  }

  const bins = new Map<number, TimelineBin>();
  for (let at = start; at <= end; at = nextBin(at)) {
    bins.set(at, { startAt: at, total: 0, counts: {} });
  }

  for (const note of included) {
    const at = binStart(note.createdAt);
    const bin = bins.get(at);
    // MONITOR_START_AT より前の createdAt など、範囲外の異常データは集計対象外にする。
    if (!bin) continue;

    bin.total++;
    const resolved = resolveClusterId(note.clusterId, clusters);
    if (resolved) bin.counts[resolved] = (bin.counts[resolved] ?? 0) + 1;
  }

  return {
    generatedAt: now,
    binMinutes: BIN_MINUTES,
    bins: Array.from(bins.values()).sort((a, b) => a.startAt - b.startAt),
  };
}

// ── 公開スナップショットの書き出し ──────────────────────────

/**
 * notes.json / clusters.json / timeline.json をまとめて Blob に書き出す。
 * persistAll の後継。読み戻しはしない一方向のエクスポートであり、
 * Postgres が唯一の真実であることに変わりはない（Blob はここでしか作れない
 * 副産物）。
 *
 * この3ファイルは Blob 上の独立したオブジェクトであり、3件セットのトランザクションは
 * 存在しない（片方だけ更新されて他方が古いままになる瞬間が起こり得る）。
 * そのため timeline が「保存されていないクラスタ」を参照する状態を作らないよう、
 * timeline は notes/clusters を書き終えた後に、読み出した値から再構築して最後に書く。
 * （途中でプロセスが落ちても、最悪 timeline が一世代古いままになるだけで済む）
 */
export async function publishSnapshot(now: number = Date.now()): Promise<void> {
  const { notes, clusters } = await readSnapshot();

  const notesFile: NotesFile = { generatedAt: now, notes };
  const clustersFile: ClustersFile = { generatedAt: now, clusters };

  await writeJson(PATH.notes, notesFile);
  await writeJson(PATH.clusters, clustersFile);

  const timeline = buildTimeline(notes, clusters, now);
  await writeJson(PATH.timeline, timeline);
}
