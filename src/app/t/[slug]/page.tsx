import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listDailyReports, readJson, readText, tenantPaths } from "@/lib/blob";
import { generateMock, mockPublicConfig, shouldUseMock } from "@/lib/mock";
import { readPublicConfig } from "@/lib/tenant/publish";
import { hhmm, isoDate, mmddhhmm, stampJst } from "@/lib/time";
import type { ClustersFile, CrossPostsFile, NotesFile, TimelineFile } from "@/lib/types";
import {
  buildAllDisplayClusters,
  buildDisplayClusters,
  computeStatCards,
  nowMs,
  peakBinIndex,
  safeIsMonitoringEnded,
  safeMonitoringEndedLabel,
  toChartBins,
  toViewNotes,
  visibleNotes,
} from "@/lib/view";
import { CrossPlatformTab } from "@/app/_components/CrossPlatformTab";
import { FetchFailureNotice } from "@/app/_components/FetchFailureNotice";
import { Footer } from "@/app/_components/Footer";
import { Header } from "@/app/_components/Header";
import { ReportSection } from "@/app/_components/ReportSection";
import { StatCards } from "@/app/_components/StatCards";
import { Tabs } from "@/app/_components/Tabs";
import { TimelineExplorer } from "@/app/_components/timeline/TimelineExplorer";

// Blob の3ファイルは10分ごとにしか更新されないため(spec.md §5.2)、ISR も同じ間隔に揃える。
export const revalidate = 600;

// 事例はビルド時に列挙せず、初回アクセスで生成する
export function generateStaticParams(): { slug: string }[] {
  return [];
}

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const config = await readPublicConfig(slug).catch(() => null);
  if (!config) return {};
  return { title: config.siteTitle, description: config.siteDescription };
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  // 現在時刻は一度だけ取得して使い回す。
  const now = nowMs();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const showExcluded = sp.showExcluded === "1";
  const useMock = shouldUseMock(sp.mock);
  const initialTab = sp.tab === "other" ? "other" : "x";

  // モック表示は Blob を持たない手元環境でも見られるよう、設定が読めなければ代わりの設定を使う
  const config = useMock
    ? ((await readPublicConfig(slug).catch(() => null)) ?? mockPublicConfig(slug))
    : await readPublicConfig(slug);
  if (!config) notFound();

  let notesFile: NotesFile | null = null;
  let clustersFile: ClustersFile | null = null;
  let timelineFile: TimelineFile | null = null;
  let crossPostsFile: CrossPostsFile | null = null;
  let cumulativeMarkdown: string | null = null;
  let archiveDates: string[] = [];
  let fetchFailed = false;

  if (useMock) {
    const mock = generateMock(config);
    notesFile = mock.notes;
    clustersFile = mock.clusters;
    timelineFile = mock.timeline;
    crossPostsFile = mock.crossPosts;
    cumulativeMarkdown = mock.report;
    const lastMoment = config.keyMoments.at(-1);
    archiveDates = [isoDate(lastMoment?.at ?? config.monitorStartAt)];
  } else {
    const paths = tenantPaths(slug);
    try {
      [notesFile, clustersFile, timelineFile, crossPostsFile, cumulativeMarkdown, archiveDates] = await Promise.all([
        readJson<NotesFile>(paths.notes),
        readJson<ClustersFile>(paths.clusters),
        readJson<TimelineFile>(paths.timeline),
        readJson<CrossPostsFile>(paths.crossPosts),
        readText(paths.cumulativeReport),
        listDailyReports(slug),
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
    binMinutes: config.binMinutes,
    bins: [],
  };

  // グラフ・凡例・統計カードは常に「除外を除いた」件数で組み立てる(公開向けの正式な数値)。
  // showExcluded はノート単位の閲覧(詳細パネル)にのみ影響する管理ビュー。
  const nonExcluded = notes.filter((n) => !n.excluded);
  const display = buildDisplayClusters(nonExcluded, clusters);
  const chartBins = toChartBins(timeline.bins, display);
  // 他プラットフォームのチャートを X タイムラインと同じ時間軸に揃えるための共通軸。
  // timeline.bins は連続ビンなので、その先頭・本数・刻み幅がそのまま軸になる。
  // bins が空（取得失敗など）のときは null を渡し、非X側は従来どおり自前の範囲にフォールバックする。
  const crossAxis =
    timeline.bins.length > 0
      ? { startAt: timeline.bins[0].startAt, binCount: timeline.bins.length, binMs: timeline.binMinutes * 60 * 1000 }
      : null;
  // レポートのクラスタ別ブロック(design.md §6.7)は9位以下も含めた全クラスタに対応する
  // 必要があるため、グラフ用の上位8+その他集約(display.order)ではなく全件を渡す。
  const allClusters = buildAllDisplayClusters(nonExcluded, clusters);
  const stats = computeStatCards(notes, display, timeline, showExcluded);

  const panelNotes = toViewNotes(visibleNotes(notes, showExcluded), clusters, showExcluded);

  const generatedAt = timelineFile?.generatedAt ?? notesFile?.generatedAt ?? null;
  const periodLabel =
    timeline.bins.length > 0 ? `${mmddhhmm(timeline.bins[0].startAt)}〜` : "収集準備中";
  const monitoringEnded = safeIsMonitoringEnded(config, now);

  return (
    <div className="mx-auto flex w-full max-w-[1024px] flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <Header
        config={config}
        periodLabel={periodLabel}
        totalNotes={stats.totalNotes}
        updatedAtLabel={generatedAt ? stampJst(generatedAt) : null}
        monitoringEnded={monitoringEnded}
        monitoringEndedLabel={safeMonitoringEndedLabel(config)}
      />

      <Tabs
        initialTab={initialTab}
        xPanel={
          <div className="flex flex-col gap-8">
            <div>
              {fetchFailed && <FetchFailureNotice asOfLabel={hhmm(now)} />}
              <StatCards stats={stats} binMinutes={timeline.binMinutes} config={config} />
            </div>
            <TimelineExplorer
              bins={chartBins}
              legend={display.order}
              notes={panelNotes}
              binMinutes={timeline.binMinutes}
              keyMoments={config.keyMoments}
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
            <CrossPlatformTab
              posts={crossPostsFile.posts}
              axis={crossAxis}
              binMinutes={timeline.binMinutes}
              keyMoments={config.keyMoments}
            />
          ) : (
            <p className="rounded-xl border border-line bg-card p-4 text-[13px] text-label">
              他プラットフォームの観測データはまだありません。
            </p>
          )
        }
      />

      <Footer config={config} />
    </div>
  );
}
