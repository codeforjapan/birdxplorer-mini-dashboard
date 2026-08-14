import { BIN_MINUTES, MAINSHOCK_AT } from "@/lib/constants";
import { PATH, listDailyReports, readJson, readText } from "@/lib/blob";
import { generateMock, shouldUseMock } from "@/lib/mock";
import { hhmm, mmddhhmm, stampJst } from "@/lib/time";
import type { ClustersFile, CrossPostsFile, NotesFile, TimelineFile } from "@/lib/types";
import {
  buildAllDisplayClusters,
  buildDisplayClusters,
  computeStatCards,
  nowMs,
  peakBinIndex,
  safeIsMonitoringEnded,
  toChartBins,
  toViewNotes,
  visibleNotes,
} from "@/lib/view";
import { CrossPlatformTab } from "./_components/CrossPlatformTab";
import { FetchFailureNotice } from "./_components/FetchFailureNotice";
import { Footer } from "./_components/Footer";
import { Header } from "./_components/Header";
import { ReportSection } from "./_components/ReportSection";
import { StatCards } from "./_components/StatCards";
import { Tabs } from "./_components/Tabs";
import { TimelineExplorer } from "./_components/timeline/TimelineExplorer";

// Blob の3ファイルは10分ごとにしか更新されないため(spec.md §5.2)、ISR も同じ間隔に揃える。
export const revalidate = 600;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  // 現在時刻は一度だけ取得して使い回す。
  const now = nowMs();
  const sp = await searchParams;
  const showExcluded = sp.showExcluded === "1";
  const useMock = shouldUseMock(sp.mock);
  const initialTab = sp.tab === "other" ? "other" : "x";

  let notesFile: NotesFile | null = null;
  let clustersFile: ClustersFile | null = null;
  let timelineFile: TimelineFile | null = null;
  let crossPostsFile: CrossPostsFile | null = null;
  let cumulativeMarkdown: string | null = null;
  let archiveDates: string[] = [];
  let fetchFailed = false;

  if (useMock) {
    const mock = generateMock();
    notesFile = mock.notes;
    clustersFile = mock.clusters;
    timelineFile = mock.timeline;
    crossPostsFile = mock.crossPosts;
    cumulativeMarkdown = mock.report;
    archiveDates = ["2026-07-28"];
  } else {
    try {
      [notesFile, clustersFile, timelineFile, crossPostsFile, cumulativeMarkdown, archiveDates] = await Promise.all([
        readJson<NotesFile>(PATH.notes),
        readJson<ClustersFile>(PATH.clusters),
        readJson<TimelineFile>(PATH.timeline),
        readJson<CrossPostsFile>(PATH.crossPosts),
        readText(PATH.cumulativeReport),
        listDailyReports(),
      ]);
    } catch {
      // Blob未生成(初回デプロイ)なのか、認証・ネットワーク障害なのかをここでは区別できない。
      // 「クラッシュさせない」(§9)を優先し、失敗時は全データ null のまま
      // ゼロ件相当の表示 + 取得失敗バナーに倒す。
      fetchFailed = true;
    }
  }

  const notes = notesFile?.notes ?? [];
  const clusters = clustersFile?.clusters ?? [];
  const timeline: TimelineFile = timelineFile ?? {
    generatedAt: now,
    binMinutes: BIN_MINUTES,
    bins: [],
  };

  // グラフ・凡例・統計カードは常に「除外を除いた」件数で組み立てる(公開向けの正式な数値)。
  // showExcluded はノート単位の閲覧(詳細パネル)にのみ影響する管理ビュー。
  const nonExcluded = notes.filter((n) => !n.excluded);
  const display = buildDisplayClusters(nonExcluded, clusters);
  const chartBins = toChartBins(timeline.bins, display);
  // レポートのクラスタ別ブロック(design.md §6.7)は9位以下も含めた全クラスタに対応する
  // 必要があるため、グラフ用の上位8+その他集約(display.order)ではなく全件を渡す。
  const allClusters = buildAllDisplayClusters(nonExcluded, clusters);
  const stats = computeStatCards(notes, display, timeline, showExcluded);

  const panelNotes = toViewNotes(visibleNotes(notes, showExcluded), clusters, showExcluded);

  const generatedAt = timelineFile?.generatedAt ?? notesFile?.generatedAt ?? null;
  const periodLabel =
    timeline.bins.length > 0 ? `${mmddhhmm(timeline.bins[0].startAt)}〜` : "収集準備中";
  const monitoringEnded = safeIsMonitoringEnded();

  return (
    <div className="mx-auto flex w-full max-w-[1024px] flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <Header
        periodLabel={periodLabel}
        totalNotes={stats.totalNotes}
        updatedAtLabel={generatedAt ? stampJst(generatedAt) : null}
        monitoringEnded={monitoringEnded}
      />

      <Tabs
        initialTab={initialTab}
        xPanel={
          <div className="flex flex-col gap-8">
            <div>
              {fetchFailed && <FetchFailureNotice asOfLabel={hhmm(now)} />}
              <StatCards stats={stats} binMinutes={timeline.binMinutes} />
            </div>
            <TimelineExplorer
              bins={chartBins}
              legend={display.order}
              notes={panelNotes}
              binMinutes={timeline.binMinutes}
              mainshockAt={MAINSHOCK_AT}
              initialSelectedIndex={peakBinIndex(timeline.bins)}
            />
            {cumulativeMarkdown && (
              <ReportSection
                title="累積レポート"
                metaLine="データソース: BirdXplorer / Xコミュニティノート ・ 更新: 毎日15:00 JST"
                markdown={cumulativeMarkdown}
                clusters={allClusters}
                archiveDates={archiveDates}
              />
            )}
          </div>
        }
        otherPanel={
          crossPostsFile && crossPostsFile.posts.length > 0 ? (
            <CrossPlatformTab posts={crossPostsFile.posts} />
          ) : (
            <p className="rounded-xl border border-line bg-card p-4 text-[13px] text-label">
              他プラットフォームの観測データはまだありません。
            </p>
          )
        }
      />

      <Footer />
    </div>
  );
}
