import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readJson, readText, tenantPaths } from "@/lib/blob";
import { readPublicConfig } from "@/lib/tenant/publish";
import type { ClustersFile, NotesFile } from "@/lib/types";
import { digestWindow, jstDateStart, mmdd, mmddhhmm } from "@/lib/time";
import { buildAllDisplayClusters, nowMs, safeIsMonitoringEnded, safeMonitoringEndedLabel } from "@/lib/view";
import { Footer } from "@/app/_components/Footer";
import { Header } from "@/app/_components/Header";
import { ReportSection } from "@/app/_components/ReportSection";

// 日次ダイジェストは確定後に書き換えられない(spec.md §5.2)。頻繁な再検証は不要だが、
// 「初回アクセス時にはまだ生成されていなかった日」を後から拾えるよう、無期限キャッシュにはしない。
export const revalidate = 3600;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function generateStaticParams(): { slug: string; date: string }[] {
  return [];
}

type Params = Promise<{ slug: string; date: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const config = await readPublicConfig(slug).catch(() => null);
  if (!config || config.status === "draft") return {};
  return { title: config.siteTitle, description: config.siteDescription };
}

export default async function DailyReportPage({ params }: { params: Params }) {
  const { slug, date } = await params;

  // 不正な形式のURLはもちろん、実在する日付かどうかも Date.parse で弾く
  // (例: "2026-02-30" のような形式だけ正しいカレンダー上存在しない日付)。
  if (!DATE_RE.test(date) || Number.isNaN(jstDateStart(date))) {
    notFound();
  }

  // 設定の読み取り失敗は 404 にせず例外のまま返す（404 が ISR にキャッシュされて生成済みのページが消えるため）。
  // draft は作業中の事例なので公開しない
  const config = await readPublicConfig(slug);
  if (!config || config.status === "draft") notFound();
  const paths = tenantPaths(slug);

  const markdown = await readText(paths.dailyReport(date)).catch(() => null);
  if (markdown === null) {
    // Blobが存在しない(まだ生成されていない、あるいは日付を打ち間違えた)場合は404に倒す。
    notFound();
  }

  // クラスタ別ブロックの色・件数バッジをその日のダイジェスト範囲(前日15:00〜当日15:00)に
  // 正しく対応させるため、notes/clusters も取得して当日分だけに絞り込む。
  const [notesFile, clustersFile] = await Promise.all([
    readJson<NotesFile>(paths.notes).catch(() => null),
    readJson<ClustersFile>(paths.clusters).catch(() => null),
  ]);
  const { from, to } = digestWindow(jstDateStart(date));
  const dayNotes = (notesFile?.notes ?? []).filter(
    (n) => !n.excluded && n.createdAt >= from && n.createdAt < to,
  );
  // レポートのクラスタ別ブロック(design.md §6.7)は9位以下も含めた全クラスタに対応する
  // 必要があるため、グラフ用の上位8+その他集約ではなく全件を渡す。
  const allClusters = buildAllDisplayClusters(dayNotes, clustersFile?.clusters ?? []);

  return (
    <div className="mx-auto flex w-full max-w-[1024px] flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <Header
        config={config}
        periodLabel={`${mmddhhmm(from)}〜${mmddhhmm(to)}`}
        totalNotes={dayNotes.length}
        updatedAtLabel={null}
        monitoringEnded={safeIsMonitoringEnded(config, nowMs())}
        monitoringEndedLabel={safeMonitoringEndedLabel(config)}
      />
      <ReportSection
        title={`日次ダイジェスト ${mmdd(jstDateStart(date))}`}
        metaLine={`データソース: BirdXplorer / Xコミュニティノート ・ ${date} 15:00 JST 確定分(以後変更なし)`}
        markdown={markdown}
        clusters={allClusters}
        archiveDates={[]}
      />
      <Footer config={config} />
    </div>
  );
}
