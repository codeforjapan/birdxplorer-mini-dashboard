import { createCluster } from "@/lib/clusters";
import { assignClusters, judgeRelevance, scoreRelevance } from "@/lib/llm";
import type { AssignInput, RelevanceInput } from "@/lib/llm";
import type { Classification } from "@/lib/birdxplorer";
import type { TenantConfig } from "@/lib/tenant/types";
import { RELEVANCE_RELATED, RELEVANCE_UNRELATED } from "@/lib/types";
import type { Cluster } from "@/lib/types";

/**
 * Stage1（関連性判定）→ Stage2（クラスタ割当）をひとまとめに実行する共通ロジック。
 *
 * ingest の「新規取得ノート」と「再試行キューからの排出」の両方から呼ばれる。
 * 呼び出しを1本にまとめているのは、両者で分岐すると新規クラスタの採番ロジックが
 * 二重管理になり、同じ噂に対して別々のクラスタIDが振られる事故を招きやすいため。
 *
 * `clusters` は呼び出し側の配列をその場で拡張する（新規クラスタを push する）。
 * 同一 cron 実行内で本編バッチ→リトライバッチの順に2回呼んでも、後段の呼び出しが
 * 前段で採番されたクラスタを認識できるようにするための意図的な副作用。
 */

export type Candidate = {
  noteId: string;
  summary: string;
  /** 分類精度のためだけに使う。呼び出し側はこの値を保存してはならない。 */
  postText: string | null;
};

export type ClassifyResult = {
  /** 分類が完了したノートの結果。 */
  classifications: Map<string, Classification>;
  /** Stage1/Stage2 いずれかで LLM 応答が得られなかったノート。 */
  failedNoteIds: Set<string>;
  failureReasons: Map<string, string>;
  /** このバッチ呼び出しの中で新規に採番されたクラスタ（呼び出し側が upsertClusters すること）。 */
  newClusters: Cluster[];
};

/** Stage1 の結果を方式によらない形にそろえたもの。以降の処理は方式を意識しない。 */
type Stage1Entry = { noteId: string; relevance: number; passed: boolean; reason: string };

async function runStage1(
  cfg: TenantConfig,
  inputs: RelevanceInput[],
): Promise<{ entries: Stage1Entry[]; failedNoteIds: string[] }> {
  if (cfg.relevanceMode === "binary") {
    const r = await judgeRelevance(cfg, inputs);
    return {
      entries: r.results.map((x) => {
        const passed = x.verdict === "related";
        return {
          noteId: x.noteId,
          relevance: passed ? RELEVANCE_RELATED : RELEVANCE_UNRELATED,
          passed,
          reason: x.reason,
        };
      }),
      failedNoteIds: r.failedNoteIds,
    };
  }
  const r = await scoreRelevance(cfg, inputs);
  return {
    entries: r.results.map((x) => ({
      noteId: x.noteId,
      relevance: x.relevance,
      passed: x.relevance >= cfg.relevanceThreshold,
      reason: x.reason,
    })),
    failedNoteIds: r.failedNoteIds,
  };
}

export async function classifyBatch(
  cfg: TenantConfig,
  clusters: Cluster[],
  candidates: Candidate[],
): Promise<ClassifyResult> {
  const classifications = new Map<string, Classification>();
  const failedNoteIds = new Set<string>();
  const failureReasons = new Map<string, string>();
  const newClusters: Cluster[] = [];

  if (candidates.length === 0) {
    return { classifications, failedNoteIds, failureReasons, newClusters };
  }

  const now = Date.now();
  const summaryByNoteId = new Map(candidates.map((c) => [c.noteId, c.summary]));

  // ── Stage1: 関連性判定 ──
  const relevanceInputs: RelevanceInput[] = candidates.map((c) => ({
    noteId: c.noteId,
    summary: c.summary,
    postText: c.postText,
  }));
  const stage1 = await runStage1(cfg, relevanceInputs);
  for (const noteId of stage1.failedNoteIds) {
    failedNoteIds.add(noteId);
    failureReasons.set(noteId, "stage1(relevance): LLM 応答が得られなかった");
  }

  const relevanceByNoteId = new Map(stage1.entries.map((r) => [r.noteId, r]));
  const passedRelevance = stage1.entries.filter((r) => r.passed);

  // 不通過はソフト除外として確定させる（Stage2 には進めない。データからは消さない — docs/spec.md §4）。
  for (const r of stage1.entries) {
    if (!r.passed) {
      classifications.set(r.noteId, {
        relevance: r.relevance,
        excluded: true,
        excludeReason: r.reason,
        clusterId: null,
        classifiedAt: now,
        classifierVersion: cfg.classifierVersion,
      });
    }
  }

  // ── Stage2: クラスタ割当（Stage1 を通過したノートのみ）──
  const assignInputs: AssignInput[] = passedRelevance.map((r) => ({
    noteId: r.noteId,
    summary: summaryByNoteId.get(r.noteId) ?? "",
  }));
  const stage2 = await assignClusters(cfg, clusters, assignInputs);
  for (const noteId of stage2.failedNoteIds) {
    failedNoteIds.add(noteId);
    failureReasons.set(noteId, "stage2(assign): LLM 応答が得られなかった");
  }

  // 新規クラスタ提案の重複排除。
  // 意味的な類似判定はせず、trim した name の完全一致でグルーピングする。
  // Stage2 のプロンプトが「短い定型的な日本語名にする」ことを強く指示しているため、
  // 同じ噂であれば同一チャンク内では同じ名前になりやすいという前提に立った、
  // コストと確実性のトレードオフとしての単純な実装。
  const newClusterIdByName = new Map<string, string>();
  for (const assignment of stage2.results) {
    if (assignment.kind !== "new") continue;
    const key = assignment.name.trim();
    if (newClusterIdByName.has(key)) continue;

    // LLM にIDを発明させない: 採番は必ずこちら側の createCluster で行う。
    const created = createCluster(clusters, assignment.name, assignment.description, now);
    clusters.push(created); // 以後の nextClusterId / nextColorIndex 採番に反映させる
    newClusters.push(created);
    newClusterIdByName.set(key, created.id);
  }

  for (const assignment of stage2.results) {
    const relevance = relevanceByNoteId.get(assignment.noteId);
    if (!relevance) continue; // assignInputs は passedRelevance 由来なので理論上は必ず見つかる

    const clusterId =
      assignment.kind === "existing" ? assignment.clusterId : newClusterIdByName.get(assignment.name.trim());
    if (!clusterId) continue; // 理論上到達しない防御（新規クラスタの採番に必ず成功しているため）

    classifications.set(assignment.noteId, {
      relevance: relevance.relevance,
      excluded: false,
      excludeReason: null,
      clusterId,
      classifiedAt: now,
      classifierVersion: cfg.classifierVersion,
    });
  }

  return { classifications, failedNoteIds, failureReasons, newClusters };
}
