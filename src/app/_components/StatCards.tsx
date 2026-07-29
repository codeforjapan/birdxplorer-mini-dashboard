import { MAINSHOCK_AT, MAINSHOCK_MAGNITUDE } from "@/lib/constants";
import { hhmm } from "@/lib/time";
import { formatCount, type StatCards as StatCardsData } from "@/lib/view";

/**
 * 統計カード(design.md §6.2)。カード3・4(最大クラスタ・ピーク帯)は呼び出し側で
 * 実データから算出済みの値を受け取るだけで、ここではハードコードしない。
 * カード2(本震)だけは spec.md 上固定の事実(M7.1 / 16:27)なので定数から組み立てる。
 *
 * 件数は formatCount で整形する。toLocaleString は環境によって表記が変わり
 * ハイドレーション不一致を招くため使わない(view.ts のコメント参照)。
 */
export function StatCards({ stats, binMinutes }: { stats: StatCardsData; binMinutes: number }) {
  const peak = stats.peakBin;
  const peakRangeLabel = peak
    ? `${hhmm(peak.startAt)}〜${hhmm(peak.startAt + binMinutes * 60 * 1000)}`
    : "—";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="総ノート数"
        value={`${formatCount(stats.totalNotesAll ?? stats.totalNotes)}件`}
        hint={
          stats.excludedCount !== null ? `うち除外${formatCount(stats.excludedCount)}件` : undefined
        }
      />
      <StatCard
        label="本震"
        value={`${MAINSHOCK_MAGNITUDE} / ${hhmm(MAINSHOCK_AT)}`}
        valueClassName="text-accent"
      />
      <StatCard
        label="最大クラスタ"
        value={stats.largestCluster?.name ?? "—"}
        hint={stats.largestCluster ? `${formatCount(stats.largestCluster.count)}件` : undefined}
      />
      <StatCard
        label="ピーク帯"
        value={peakRangeLabel}
        hint={peak ? `${formatCount(peak.total)}件/${binMinutes}分` : undefined}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-4">
      <div className="tabular text-[10px] uppercase tracking-wide text-label">{label}</div>
      <div className={`tabular mt-1 truncate text-[16px] font-bold text-heading ${valueClassName ?? ""}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
