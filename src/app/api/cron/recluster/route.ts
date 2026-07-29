import { activeClusters, resolveClusterId } from "@/lib/clusters";
import { runCronJob } from "@/lib/cron";
import { planRecluster } from "@/lib/llm";
import type { ReclusterPlan, ReportCluster } from "@/lib/llm";
import { publishSnapshot, readClusters, readNotes, upsertClusters } from "@/lib/store";
import type { Cluster, Note } from "@/lib/types";
import { ensureMigrated } from "../_lib/migrate-once";

// migrate() が node:fs に依存するため（ingest/route.ts のコメント参照）。
export const runtime = "nodejs";

/**
 * LLM 呼び出しは1回（chatJson の壁時計予算は最大45秒）＋ Postgres の読み書きのみで、
 * ingest のようなページングやチャンク分割の繰り返しがない。コールドスタート（db.ts 参照）
 * を吸収できる程度の余裕を見て、10秒既定よりは十分長いが ingest より短い値にする。
 */
export const maxDuration = 90;

// 1クラスタあたり LLM に渡す代表ノートの件数。多すぎるとプロンプトが肥大化するため、
// 直近のノートを少数だけ渡す（「今このクラスタが何を指しているか」の判断材料として十分）。
const SAMPLE_SIZE = 5;

/** 除外されていないノートを resolveClusterId 済みのクラスタIDでグルーピングし、代表ノートを添える。 */
function buildReportClusters(clusters: readonly Cluster[], notes: readonly Note[]): ReportCluster[] {
  const active = activeClusters(clusters);
  if (active.length === 0) return [];

  const grouped = new Map<string, Note[]>();
  for (const note of notes) {
    if (note.excluded) continue;
    const resolved = resolveClusterId(note.clusterId, clusters);
    if (!resolved) continue;
    const list = grouped.get(resolved);
    if (list) list.push(note);
    else grouped.set(resolved, [note]);
  }

  return active.map((c) => {
    const notesForCluster = grouped.get(c.id) ?? [];
    const samples = [...notesForCluster]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SAMPLE_SIZE)
      .map((n) => n.summary);
    return {
      clusterId: c.id,
      name: c.name,
      description: c.description,
      noteCount: notesForCluster.length,
      sampleSummaries: samples,
    };
  });
}

/**
 * プランを適用する。
 * merge: from クラスタに alias_of = into を立てるだけ（元IDは削除せず、notes.cluster_id も書き換えない
 *   — 参照側は必ず resolveClusterId を通す設計。src/lib/clusters.ts 参照）。
 * rename: name/description を更新する。description が null の場合はモデルが「変更なし」の意図で
 *   返してきたとみなし、既存の説明を保持する（誤って空文字に落とさないため）。
 * 変更されたクラスタだけを返す（呼び出し側が upsertClusters に渡す差分）。
 */
function applyPlan(clusters: readonly Cluster[], plan: ReclusterPlan): Cluster[] {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const changed = new Map<string, Cluster>();

  for (const { from, into } of plan.merge) {
    for (const id of from) {
      const c = byId.get(id);
      if (!c) continue; // planRecluster が実在チェック済みだが念のため
      const updated: Cluster = { ...c, aliasOf: into };
      byId.set(id, updated);
      changed.set(id, updated);
    }
  }

  for (const { id, name, description } of plan.rename) {
    const c = byId.get(id);
    if (!c) continue;
    const updated: Cluster = { ...c, name, description: description ?? c.description };
    byId.set(id, updated);
    changed.set(id, updated);
  }

  return [...changed.values()];
}

export async function POST(req: Request): Promise<Response> {
  return runCronJob("recluster", req, async () => {
    await ensureMigrated();

    const [clusters, notes] = await Promise.all([readClusters(), readNotes()]);
    const reportClusters = buildReportClusters(clusters, notes);

    const plan = await planRecluster(reportClusters);

    // null は「今回はスキップ」。状態には一切触れず、次の時間に持ち越す（決定どおり）。
    if (plan === null) {
      return { activeClusters: reportClusters.length, merged: 0, renamed: 0, skipped: 1 };
    }

    const changed = applyPlan(clusters, plan);
    await upsertClusters(changed);
    await publishSnapshot();

    const merged = plan.merge.reduce((sum, m) => sum + m.from.length, 0);
    return {
      activeClusters: reportClusters.length,
      merged,
      renamed: plan.rename.length,
      skipped: 0,
    };
  });
}
