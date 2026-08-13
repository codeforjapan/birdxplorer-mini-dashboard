import { activeClusters, clusterLookup, resolveClusterId } from "./clusters";
import { claimTypeLabel } from "./claimType";
import { BIN_MINUTES, clusterColor, MAX_DISTINCT_CLUSTERS, OTHER_CLUSTER_COLOR, OTHER_CLUSTER_ID } from "./constants";
import { isMonitoringEnded } from "./env";
import { nextBin } from "./time";
import type { Cluster, CrossPlatform, CrossPost, Note, SearchlightBadge, TimelineBin, TimelineFile } from "./types";

/**
 * 現在時刻の取得を1箇所に集約する。
 *
 * サーバーコンポーネント本体で直接 `Date.now()` を呼ぶと、React Compiler の
 * purity チェック(react-hooks/purity)が「レンダー中の不純な関数呼び出し」として
 * 警告する。取得失敗時のフォールバック表示に使う現在時刻は本質的にリクエストごとの
 * 値で問題ない(再レンダーで揺れても支障がない一度きりの表示用途)ため、
 * 呼び出しをこのユーティリティ越しにすることでコンポーネント本体の見た目上の純度を保つ。
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * 3桁区切りの件数表記。
 *
 * `toLocaleString` / `Intl` は ICU データに依存し、サーバー（Node）とブラウザで
 * 結果が異なりうる。表記が食い違えばハイドレーション不一致になるため使わない。
 * 素朴な正規表現による桁区切りは環境に依存しない。
 */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 運用終了判定の安全なラッパー。
 *
 * `isMonitoringEnded` は BLOB/KV など監視終了の判定そのものとは無関係な必須環境変数まで
 * まとめて検証する(`env()` がコア設定をひとまとめに扱うため)。フロントエンドのみを
 * 動かすローカル開発やそれらが未設定の環境でも「クラッシュさせない」(design.md §9)を
 * 優先し、判定できない場合は「終了していない」側に倒す。
 */
export function safeIsMonitoringEnded(): boolean {
  try {
    return isMonitoringEnded();
  } catch {
    return false;
  }
}

/**
 * ページ(サーバーコンポーネント)とチャート/詳細パネル(クライアントコンポーネント)の間に立つ
 * 表示ロジック層。Blob の生データ(Note/Cluster/TimelineBin)をそのままコンポーネントに渡すと
 * 「上位10 + その他」集約や alias 解決を各所で再実装することになるため、ここに集約する。
 */

/** 表示用に集約したクラスタ1件(実クラスタ、または「その他」集約)。 */
export type DisplayCluster = {
  id: string;
  name: string;
  color: string;
  /** 可視ノート(除外を除く、あるいは showExcluded 時は全件)に占める件数。凡例・チャートの件数表示に使う。 */
  count: number;
  /** スタッキング順の並べ替えに使う。「その他」は実クラスタより常に後ろに来るよう10を割り当てる。 */
  colorIndex: number;
};

export type DisplayClusterMap = {
  /**
   * 積み上げ・凡例チップの表示順。「colorIndex 順に下から積む」(§6.3)に合わせて
   * colorIndex 昇順、「その他」は末尾固定。件数順ではない。
   */
  order: DisplayCluster[];
  /**
   * 生の clusterId (alias 解決前、null 可)から表示用IDを引く。
   * 対応するクラスタが件数0で ranking に載っていない場合や、
   * clusterId が null (未分類)の場合は null を返す。
   */
  toDisplayId: (rawClusterId: string | null) => string | null;
};

/**
 * 上位8 + 「その他」集約 (design.md §3)。
 *
 * colorIndex はクラスタ作成時に採番されて以後変わらない値だが、「上位8クラスタに 0-7 を
 * 割り当てる」という記述は生成順ではなく件数順位の話。件数降順でランキングして
 * 上位8(= MAX_DISTINCT_CLUSTERS)だけを個別クラスタとして残し、9位以下を1本の
 * 「その他」セグメント(OTHER_CLUSTER_COLOR)に畳む。8という上限は表示の都合ではなく、
 * 白背景上で隣接色を判別できる categorical hue の数として検証済みの値であり、
 * 9色目以降を巡回・追加すると識別性の保証が崩れるためここで打ち切る(constants.ts参照)。
 * 畳んだ後の表示順は colorIndex 昇順(§6.3 のスタッキング順)に並べ直す。
 * 詳細パネル側は畳まずに実クラスタ名を出すため、集約はグラフ・凡例の表示層だけに閉じる。
 */
/**
 * alias 解決後の実クラスタID単位で件数を積む。ノートは吸収済みの古い clusterId を
 * 持ち続けることがあるため、必ず resolveClusterId を通す。
 * buildDisplayClusters (上位8+その他集約) と buildAllDisplayClusters (全件) の
 * どちらも同じ件数集計を土台にするため、ここに切り出す。
 */
function countByResolvedCluster(
  notes: readonly Note[],
  clusters: readonly Cluster[],
): Map<string, number> {
  const countByResolved = new Map<string, number>();
  for (const note of notes) {
    const resolved = resolveClusterId(note.clusterId, clusters);
    if (!resolved) continue;
    countByResolved.set(resolved, (countByResolved.get(resolved) ?? 0) + 1);
  }
  return countByResolved;
}

export function buildDisplayClusters(
  notes: readonly Note[],
  clusters: readonly Cluster[],
): DisplayClusterMap {
  const active = activeClusters(clusters);
  const countByResolved = countByResolvedCluster(notes, clusters);

  const ranked = active
    .map((cluster) => ({ cluster, count: countByResolved.get(cluster.id) ?? 0 }))
    .filter((entry) => entry.count > 0)
    // 件数降順。同数の場合はID順で並びを固定し、上位入りの判定がぶれないようにする。
    // localeCompare は ICU データ依存でサーバーとブラウザで結果が異なりうるため使わない
    // （順位が入れ替わると色の割り当てまで変わり、ハイドレーション不一致になる）。
    .sort((a, b) =>
      b.count - a.count || (a.cluster.id < b.cluster.id ? -1 : a.cluster.id > b.cluster.id ? 1 : 0),
    );

  const top = ranked.slice(0, MAX_DISTINCT_CLUSTERS);
  const rest = ranked.slice(MAX_DISTINCT_CLUSTERS);

  const displayIdByRealId = new Map<string, string>();
  const order: DisplayCluster[] = top.map(({ cluster, count }) => {
    displayIdByRealId.set(cluster.id, cluster.id);
    return {
      id: cluster.id,
      name: cluster.name,
      color: clusterColor(cluster.colorIndex),
      count,
      colorIndex: cluster.colorIndex,
    };
  });
  // スタッキング順(§6.3: colorIndex 順に下から積む)に並べ替える。
  order.sort((a, b) => a.colorIndex - b.colorIndex);

  if (rest.length > 0) {
    for (const { cluster } of rest) displayIdByRealId.set(cluster.id, OTHER_CLUSTER_ID);
    const otherCount = rest.reduce((sum, entry) => sum + entry.count, 0);
    // 「その他」は常に最後(最上段)に積む。ここでの 10 は表示色の添字ではなく、
    // 実クラスタの生 colorIndex(旧10色パレット時代の永続データを含め 0-9 の範囲)より
    // 確実に大きい値であることだけが目的の番兵。パレットが8色になった後も、
    // 過去に採番済みの colorIndex 8/9 を持つクラスタより後ろに来る必要があるため、
    // MAX_DISTINCT_CLUSTERS(=8)ではなくこの値のままにしている。
    order.push({
      id: OTHER_CLUSTER_ID,
      name: "その他",
      color: OTHER_CLUSTER_COLOR,
      count: otherCount,
      colorIndex: 10,
    });
  }

  return {
    order,
    toDisplayId: (rawClusterId) => {
      const resolved = resolveClusterId(rawClusterId, clusters);
      if (!resolved) return null;
      return displayIdByRealId.get(resolved) ?? null;
    },
  };
}

/**
 * 全アクティブクラスタ(集約なし)。件数はグラフの上位8集約とは無関係に、渡された
 * notes から独立に数え直す。
 *
 * レポートセクション(design.md §6.7)のクラスタ別ブロックは、9位以下も含めた
 * 「クラスタ別まとめ」の全項目に対応する必要がある。`buildDisplayClusters.order` は
 * グラフ・凡例の都合で上位8+「その他」に畳んだものなので、レポート側の名前解決には
 * 使えない(9位以下がまるごと欠落する)。畳む前の実クラスタ全件をここで返す。
 */
export function buildAllDisplayClusters(
  notes: readonly Note[],
  clusters: readonly Cluster[],
): DisplayCluster[] {
  const active = activeClusters(clusters);
  const countByResolved = countByResolvedCluster(notes, clusters);

  return active.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    color: clusterColor(cluster.colorIndex),
    count: countByResolved.get(cluster.id) ?? 0,
    colorIndex: cluster.colorIndex,
  }));
}

/** ビン1つ分を表示用クラスタ単位に再集計したセグメント。件数0のクラスタは含めない。 */
export function binSegments(
  bin: TimelineBin,
  display: DisplayClusterMap,
): { id: string; count: number }[] {
  const byDisplay = new Map<string, number>();
  for (const [rawClusterId, count] of Object.entries(bin.counts)) {
    const displayId = display.toDisplayId(rawClusterId);
    if (!displayId) continue;
    byDisplay.set(displayId, (byDisplay.get(displayId) ?? 0) + count);
  }
  // display.order の並び順(colorIndex昇順・その他は最後)を保ったまま返す。積み上げ順と一致させるため。
  return display.order
    .map((c) => ({ id: c.id, count: byDisplay.get(c.id) ?? 0 }))
    .filter((s) => s.count > 0);
}

export type StatCards = {
  /** 常に非除外件数(公開向けの正式な値)。ヘッダーの集計件数など既定表示に使う。 */
  totalNotes: number;
  /**
   * 管理ビュー(?showExcluded=1)時のみ値を持つ: 除外を含む全件数。
   * spec.md §4 Stage1「データからは消さず、管理用の別ビューで確認できる」を
   * 統計カードでも満たすため、総ノート数カードだけ管理ビューでは全件数に切り替える
   * (design.md §6.2)。既定ビューでは null にし、値そのものをプロップスに乗せない。
   */
  totalNotesAll: number | null;
  /** 管理ビュー時のみ値を持つ: 除外件数(totalNotesAll - totalNotes)。 */
  excludedCount: number | null;
  largestCluster: { name: string; count: number } | null;
  peakBin: { startAt: number; total: number } | null;
};

/** 統計カード3・4(最大クラスタ・ピーク帯)の値を動的に算出する。ハードコードしない。 */
export function computeStatCards(
  notes: readonly Note[],
  display: DisplayClusterMap,
  timeline: TimelineFile | null,
  showAdminInfo: boolean,
): StatCards {
  const totalNotes = notes.filter((n) => !n.excluded).length;

  // display.order は colorIndex 順であって件数順ではないため、最大クラスタは
  // 「その他」を除いた実クラスタの中から件数最大のものを改めて探す。
  const largest = display.order
    .filter((c) => c.id !== OTHER_CLUSTER_ID)
    .reduce<DisplayCluster | null>((best, c) => (!best || c.count > best.count ? c : best), null);

  let peakBin: StatCards["peakBin"] = null;
  if (timeline) {
    for (const bin of timeline.bins) {
      if (!peakBin || bin.total > peakBin.total) peakBin = { startAt: bin.startAt, total: bin.total };
    }
  }

  return {
    totalNotes,
    totalNotesAll: showAdminInfo ? notes.length : null,
    excludedCount: showAdminInfo ? notes.length - totalNotes : null,
    largestCluster: largest ? { name: largest.name, count: largest.count } : null,
    peakBin,
  };
}

/** 除外ノートは既定で非表示。?showExcluded=1 の管理ビューでのみ表示する(spec.md §7)。 */
export function visibleNotes(notes: readonly Note[], showExcluded: boolean): Note[] {
  return showExcluded ? [...notes] : notes.filter((n) => !n.excluded);
}

/** 件数最大のビンのインデックス。詳細パネルの初期選択に使う(design.md §6.5)。 */
export function peakBinIndex(bins: readonly TimelineBin[]): number {
  let best = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].total > bins[best].total) best = i;
  }
  return best;
}

/** ビンに属するノート一覧(時刻昇順)。詳細パネル・テーブルフォールバック共通で使う。 */
export function notesInBin(notes: readonly Note[], bin: TimelineBin): Note[] {
  const end = nextBin(bin.startAt);
  return notes
    .filter((n) => n.createdAt >= bin.startAt && n.createdAt < end)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * クライアントコンポーネントに渡す、詳細パネル用のノート表現。
 *
 * サーバー→クライアントの props はシリアライズ可能な値のみ許されるため、Map や
 * resolveClusterId のようなクロージャは渡せない。alias解決とクラスタ名・色の紐付けは
 * ここで完結させ、プレーンなオブジェクトだけをクライアント側に渡す。
 * 詳細パネルは集約前の実クラスタ名を出す(§3)ため、DisplayCluster ではなくこちらを使う。
 */
export type ViewNote = {
  noteId: string;
  createdAt: number;
  summary: string;
  postUrl: string;
  currentStatus: Note["currentStatus"];
  excluded: boolean;
  /** alias解決済みの実クラスタ。分類前(clusterId が null)やクラスタ未取得時は null。 */
  cluster: { id: string; name: string; color: string } | null;
  /**
   * 管理ビュー(?showExcluded=1)で除外ノートを開いたときのみ値を持つ:
   * spec.md §4 Stage1 の関連性スコアと除外理由。閾値(60)のチューニング検証に使う。
   * 内部スコアを公開サイトに晒さないため、非管理ビュー・非除外ノートでは
   * 常に null にし、値そのものをprops(RSCのシリアライズ経路)に乗せない。
   */
  adminInfo: { relevance: number; excludeReason: string | null } | null;
  /** Searchlight バッジ（Note からそのまま透過）。マッチした時のみ存在。 */
  searchlight?: SearchlightBadge;
};

export function toViewNotes(
  notes: readonly Note[],
  clusters: readonly Cluster[],
  showAdminInfo: boolean,
): ViewNote[] {
  const lookup = clusterLookup(clusters);
  return notes.map((n) => {
    const resolvedId = resolveClusterId(n.clusterId, clusters);
    const cluster = resolvedId ? lookup.get(resolvedId) : undefined;
    return {
      noteId: n.noteId,
      createdAt: n.createdAt,
      summary: n.summary,
      postUrl: n.postUrl,
      currentStatus: n.currentStatus,
      excluded: n.excluded,
      cluster: cluster
        ? { id: cluster.id, name: cluster.name, color: clusterColor(cluster.colorIndex) }
        : null,
      adminInfo:
        showAdminInfo && n.excluded ? { relevance: n.relevance, excludeReason: n.excludeReason } : null,
      searchlight: n.searchlight,
    };
  });
}

/** チャート・テーブルフォールバックに渡す、ビン1つ分のシリアライズ可能な表現。 */
export type ChartBin = {
  startAt: number;
  total: number;
  segments: { id: string; count: number }[];
};

export function toChartBins(bins: readonly TimelineBin[], display: DisplayClusterMap): ChartBin[] {
  return bins.map((bin) => ({
    startAt: bin.startAt,
    total: bin.total,
    segments: binSegments(bin, display),
  }));
}

/** 評価状態バッジの日本語表示。null は「未評価」として扱う(design.md §6.5)。 */
export function statusLabel(status: Note["currentStatus"]): string {
  switch (status) {
    case "CURRENTLY_RATED_HELPFUL":
      return "有用と評価";
    case "CURRENTLY_RATED_NOT_HELPFUL":
      return "有用でないと評価";
    case "NEEDS_MORE_RATINGS":
      return "評価不足";
    case null:
      return "未評価";
  }
}

// ── 非X（クロスプラットフォーム）PF別サマリー ──
// UI（CrossPlatformSection）から集計を切り離した純関数。カード＝俯瞰の材料をPF単位で返す。
// 集計は全件（crossPostsFile.posts）を対象にする。表示上の件数制限は集計に影響させない。

/** カード＝タブの並び順（固定）。件数0のPFは buildCrossPlatformSummary が除外する。 */
export const CROSS_PF_ORDER: readonly CrossPlatform[] = ["youtube", "tiktok", "threads", "web"];

export type CrossStanceCounts = { spreading: number; debunking: number; reporting: number; neutral: number };
/** 規模はPFで指標が違うため代表を1つ選ぶ: views→likes→なし。 */
export type CrossScale = { kind: "views" | "likes" | "none"; max: number | null };

/** null/NEUTRAL は「中立」に寄せる。 */
function tallyStance(posts: readonly CrossPost[]): CrossStanceCounts {
  const c: CrossStanceCounts = { spreading: 0, debunking: 0, reporting: 0, neutral: 0 };
  for (const p of posts) {
    if (p.stance === "SPREADING") c.spreading += 1;
    else if (p.stance === "DEBUNKING") c.debunking += 1;
    else if (p.stance === "REPORTING") c.reporting += 1;
    else c.neutral += 1; // NEUTRAL または null
  }
  return c;
}

/** 代表指標: views を持つ投稿があれば最大 views、無ければ likes、どちらも無ければ none。 */
function pickScale(posts: readonly CrossPost[]): CrossScale {
  const views = posts.map((p) => p.views).filter((v): v is number => typeof v === "number");
  if (views.length > 0) return { kind: "views", max: Math.max(...views) };
  const likes = posts.map((p) => p.likes).filter((v): v is number => typeof v === "number");
  if (likes.length > 0) return { kind: "likes", max: Math.max(...likes) };
  return { kind: "none", max: null };
}

/** 最頻 claim_type を日本語ラベル化。同数首位は件数降順→トークン昇順で安定させる。 */
function topClaim(posts: readonly CrossPost[]): { label: string; count: number } | null {
  if (posts.length === 0) return null;
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(p.claimType, (counts.get(p.claimType) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { label: claimTypeLabel(top[0]), count: top[1] };
}

export const CROSS_BIN_MINUTES = BIN_MINUTES;
export const CROSS_BIN_MS = CROSS_BIN_MINUTES * 60 * 1000;

/** 単系列チャートの1ビン(開始時刻＋件数)。 */
export type CrossChartBin = { startAt: number; count: number };

/** 一覧の絞り込み条件。binStartAt=null は「PF全体」。 */
export type CrossFilter = { platform: CrossPlatform; binStartAt: number | null };

/** 全PF共通の時間ビン軸。 */
export type CrossChartAxis = { startAt: number; binCount: number; binMs: number };

/** 全非X投稿の publishedAt から共通の30分ビン軸を作る。dated が無ければ null。 */
export function crossChartAxis(posts: readonly CrossPost[]): CrossChartAxis | null {
  const dated = posts.map((p) => p.publishedAt).filter((v): v is number => typeof v === "number");
  if (dated.length === 0) return null;
  const min = Math.min(...dated);
  const max = Math.max(...dated);
  const startAt = Math.floor(min / CROSS_BIN_MS) * CROSS_BIN_MS; // ビン境界に丸める
  const binCount = Math.max(1, Math.floor((max - startAt) / CROSS_BIN_MS) + 1);
  return { startAt, binCount, binMs: CROSS_BIN_MS };
}

/** 指定 PF の投稿を共通軸上の30分ビン件数へ。publishedAt null は除外(チャートに置けない)。 */
function chartBinsFor(posts: readonly CrossPost[], axis: CrossChartAxis | null): CrossChartBin[] {
  if (!axis) return [];
  const bins: CrossChartBin[] = Array.from({ length: axis.binCount }, (_, i) => ({
    startAt: axis.startAt + i * axis.binMs,
    count: 0,
  }));
  for (const p of posts) {
    if (typeof p.publishedAt !== "number") continue;
    const idx = Math.floor((p.publishedAt - axis.startAt) / axis.binMs);
    if (idx >= 0 && idx < bins.length) bins[idx].count += 1;
  }
  return bins;
}

/** 一覧を CrossFilter で絞る。filter=null は全件(順序保持)。 */
export function filterCrossPosts(posts: readonly CrossPost[], filter: CrossFilter | null): CrossPost[] {
  if (!filter) return [...posts];
  return posts.filter((p) => {
    if (p.platform !== filter.platform) return false;
    if (filter.binStartAt === null) return true;
    return (
      typeof p.publishedAt === "number" &&
      p.publishedAt >= filter.binStartAt &&
      p.publishedAt < filter.binStartAt + CROSS_BIN_MS
    );
  });
}

export type PfSummary = {
  platform: CrossPlatform;
  count: number;
  stance: CrossStanceCounts;
  highUrgency: number;
  officialConflict: number;
  scale: CrossScale;
  latestAt: number | null;
  chartBins: CrossChartBin[];
  topClaim: { label: string; count: number } | null;
};

/** PF別サマリー(chartBins は全PF共通軸)を CROSS_PF_ORDER 順に返す(件数0のPFは除外)。 */
export function buildCrossPlatformSummary(posts: readonly CrossPost[]): PfSummary[] {
  const axis = crossChartAxis(posts);
  const out: PfSummary[] = [];
  for (const platform of CROSS_PF_ORDER) {
    const group = posts.filter((p) => p.platform === platform);
    if (group.length === 0) continue;
    const groupDates = group.map((p) => p.publishedAt).filter((v): v is number => typeof v === "number");
    out.push({
      platform,
      count: group.length,
      stance: tallyStance(group),
      highUrgency: group.filter((p) => p.urgency === "HIGH").length,
      officialConflict: group.filter((p) => /conflict/i.test(p.officialRelationship)).length,
      scale: pickScale(group),
      latestAt: groupDates.length > 0 ? Math.max(...groupDates) : null,
      chartBins: chartBinsFor(group, axis),
      topClaim: topClaim(group),
    });
  }
  return out;
}
