import { CLUSTER_PALETTE } from "./constants";
import type { Cluster } from "./types";

/**
 * クラスタIDの採番と alias 解決。
 *
 * IDは永続で、マージしても削除しない（`aliasOf` を立てるだけ）。
 * IDを振り直すと時系列グラフの色分けが毎回ジャンプして履歴が読めなくなるため。
 * ノートは古い（吸収済みの）clusterId を持ち続けるので、
 * 参照側は必ず resolveClusterId を通してから使う。
 */

/** aliasOf を辿って実効クラスタIDを返す。循環しても止まる。 */
export function resolveClusterId(
  clusterId: string | null,
  clusters: readonly Cluster[],
): string | null {
  if (!clusterId) return null;
  const byId = new Map(clusters.map((c) => [c.id, c]));

  let current = clusterId;
  for (let hops = 0; hops < clusters.length + 1; hops++) {
    const next = byId.get(current)?.aliasOf;
    if (!next) return current;
    current = next;
  }
  return current;
}

/** 吸収されていない（表示対象の）クラスタ。 */
export function activeClusters(clusters: readonly Cluster[]): Cluster[] {
  return clusters.filter((c) => c.aliasOf === null);
}

/** clusterId（吸収済みを含む）から実体クラスタを引ける Map。 */
export function clusterLookup(clusters: readonly Cluster[]): Map<string, Cluster> {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const out = new Map<string, Cluster>();
  for (const c of clusters) {
    const resolved = resolveClusterId(c.id, clusters);
    const target = resolved ? byId.get(resolved) : undefined;
    if (target) out.set(c.id, target);
  }
  return out;
}

/** "c_001" 形式の次のID。既存の最大値+1。 */
export function nextClusterId(clusters: readonly Cluster[]): string {
  const max = clusters.reduce((acc, c) => {
    const n = Number(c.id.match(/^c_(\d+)$/)?.[1]);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return `c_${String(max + 1).padStart(3, "0")}`;
}

/**
 * 次の colorIndex。
 * 使用回数が最も少ない添字を選ぶので、10色を使い切るまでは重複しない。
 * 11個目以降は循環して重複するが、グラフ側で上位10クラスタのみ個別色にし
 * 残りを「その他」に集約するため、実際の表示では衝突しない。
 */
export function nextColorIndex(clusters: readonly Cluster[]): number {
  const used = new Array<number>(CLUSTER_PALETTE.length).fill(0);
  for (const c of clusters) {
    const i = ((c.colorIndex % used.length) + used.length) % used.length;
    used[i]++;
  }
  let best = 0;
  for (let i = 1; i < used.length; i++) {
    if (used[i] < used[best]) best = i;
  }
  return best;
}

/** 新規クラスタを1件作る。ID・colorIndex は既存一覧から採番する。 */
export function createCluster(
  clusters: readonly Cluster[],
  name: string,
  description: string,
  now: number = Date.now(),
): Cluster {
  return {
    id: nextClusterId(clusters),
    name,
    description,
    colorIndex: nextColorIndex(clusters),
    createdAt: now,
    aliasOf: null,
  };
}
