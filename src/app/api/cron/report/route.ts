import { PATH, readText, writeText } from "@/lib/blob";
import { activeClusters, resolveClusterId } from "@/lib/clusters";
import { runCronJob } from "@/lib/cron";
import { writeCumulativeReport, writeDailyDigest } from "@/lib/llm";
import type { ReportCluster } from "@/lib/llm";
import { readClusters, readNotes } from "@/lib/store";
import { digestWindow, isoDate } from "@/lib/time";
import type { Cluster, Note } from "@/lib/types";
import { ensureMigrated } from "../_lib/migrate-once";

// migrate() が node:fs に依存するため（ingest/route.ts のコメント参照）。
export const runtime = "nodejs";

/**
 * LLM 呼び出しが2回（Stage4 日次ダイジェスト → Stage5 累積レポート）直列に走り、
 * それぞれ chatJson の壁時計予算（最大45秒）＋ Postgres 読み出し＋ Blob I/O が乗る。
 * 1日1回しか走らないジョブなので、他の cron 間隔を圧迫する心配なく余裕を持たせられる。
 */
export const maxDuration = 120;

// 1クラスタあたりダイジェストに渡す代表ノートの件数。recluster と同じ考え方。
const SAMPLE_SIZE = 5;

function buildReportClusters(
  clusters: readonly Cluster[],
  notesInWindow: readonly Note[],
): { reportClusters: ReportCluster[]; totalNotes: number } {
  const active = activeClusters(clusters);
  const included = notesInWindow.filter((n) => !n.excluded);

  const grouped = new Map<string, Note[]>();
  for (const note of included) {
    const resolved = resolveClusterId(note.clusterId, clusters);
    if (!resolved) continue;
    const list = grouped.get(resolved);
    if (list) list.push(note);
    else grouped.set(resolved, [note]);
  }

  const reportClusters = active
    .map((c) => {
      const notesForCluster = grouped.get(c.id) ?? [];
      return {
        clusterId: c.id,
        name: c.name,
        description: c.description,
        noteCount: notesForCluster.length,
        sampleSummaries: [...notesForCluster]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, SAMPLE_SIZE)
          .map((n) => n.summary),
      };
    })
    // 0件のクラスタはダイジェストの入力に含めない（writeDailyDigest 側の指示でも省略可としている）。
    .filter((c) => c.noteCount > 0);

  return { reportClusters, totalNotes: included.length };
}

export async function POST(req: Request): Promise<Response> {
  return runCronJob("report", req, async () => {
    await ensureMigrated();

    const now = Date.now();
    const { from, to } = digestWindow(now); // 前日15:00〜当日15:00 JST
    const isoDay = isoDate(now);

    const [clusters, notes] = await Promise.all([readClusters(), readNotes()]);
    const notesInWindow = notes.filter((n) => n.createdAt >= from && n.createdAt < to);
    const { reportClusters, totalNotes } = buildReportClusters(clusters, notesInWindow);

    const stats = {
      windowNotes: notesInWindow.length,
      totalNotes,
      clusters: reportClusters.length,
      dailyWritten: 0,
      dailySkippedExisting: 0,
      dailySkippedLlmFailure: 0,
      cumulativeWritten: 0,
      cumulativeSkippedLlmFailure: 0,
    };

    // ── Stage4: 日次ダイジェスト ──
    const digest = await writeDailyDigest({ from, to, totalNotes, clusters: reportClusters });
    if (digest === null) {
      // LLM失敗。イミュータブルな一次記録を中途半端な内容で確定させるより、
      // 今回は書かずスキップする方が安全（次回実行時にまた挑戦できる）。
      stats.dailySkippedLlmFailure = 1;
      return stats;
    }

    let digestForCumulative = digest;
    const dailyResult = await writeText(PATH.dailyReport(isoDay), digest, { immutable: true });
    if (dailyResult === false) {
      // 既に確定済み（イミュータブル）。上書きはしない — writeText の仕様どおりエラーではなくスキップとして扱う。
      stats.dailySkippedExisting = 1;
      // 累積レポートには「実際に公開されている」当日ダイジェストを継ぎ足すべきなので、
      // 今回生成し直した内容ではなく既存の確定版を読み直す（同日内に cron が
      // 二重実行された場合の取り違え防止。イミュータブルなファイルの読み戻しなので
      // 「Blobを読み戻さない」原則との抵触はない — 内容が変わり得ない読み取りだから安全）。
      const published = await readText(PATH.dailyReport(isoDay), { revalidate: false });
      if (published !== null) digestForCumulative = published;
    } else {
      stats.dailyWritten = 1;
    }

    // ── Stage5: 累積レポート更新 ──
    // reports/cumulative.md は Postgres に実体を持たない Blob 専用データ（migrations/001_init.sql
    // に対応テーブルが無いことを参照）。「Blob を読み戻さない」原則は notes/clusters/timeline
    // （真実は Postgres 側にある）についての話であり、累積レポートには他に読み出し元がない。
    // blob.ts の readText が revalidate:false（ISRキャッシュを経由せず常に最新を取得）を
    // 持つのはまさにこの用途のためなので、ここに限り読み戻す。
    const previousCumulative = await readText(PATH.cumulativeReport, { revalidate: false });
    const updatedCumulative = await writeCumulativeReport(previousCumulative, digestForCumulative, isoDay);

    if (updatedCumulative === null) {
      // LLM失敗。前回の累積レポートをそのまま残す（何もしない）。
      stats.cumulativeSkippedLlmFailure = 1;
    } else {
      await writeText(PATH.cumulativeReport, updatedCumulative);
      stats.cumulativeWritten = 1;
    }

    return stats;
  });
}
