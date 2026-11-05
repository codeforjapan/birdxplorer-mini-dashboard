import type { PublicTenantConfig } from "@/lib/tenant/types";
import { binRangeLabel, binWidthLabel, hhmm } from "@/lib/time";
import { formatCount, type StatCards as StatCardsData } from "@/lib/view";

/**
 * 統計カード(design.md §6.2)。カード3・4(最大クラスタ・ピーク帯)は呼び出し側で
 * 実データから算出済みの値を受け取るだけで、ここではハードコードしない。
 * カード2(本震・投開票日など)は事例設定の整形済み値をそのまま表示する
 * （型によって形が変わるため、フォーマットの組み立てはここでは行わない）。
 *
 * 件数は formatCount で整形する。toLocaleString は環境によって表記が変わり
 * ハイドレーション不一致を招くため使わない(view.ts のコメント参照)。
 */
export function StatCards({
  stats,
  binMinutes,
  config,
}: {
  stats: StatCardsData;
  binMinutes: number;
  config: Pick<PublicTenantConfig, "keyMomentLabel" | "keyMomentValue">;
}) {
  const peak = stats.peakBin;
  const peakEnd = peak ? peak.startAt + binMinutes * 60 * 1000 : 0;
  // 日単位のビンでは時刻が 00:00〜00:00 になり読めないので日付で出す
  const peakRangeLabel = !peak
    ? "—"
    : binMinutes % 1440 === 0
      ? binRangeLabel(peak.startAt, peakEnd)
      : `${hhmm(peak.startAt)}〜${hhmm(peakEnd)}`;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="総ノート数"
        value={`${formatCount(stats.totalNotesAll ?? stats.totalNotes)}件`}
        hint={
          stats.excludedCount !== null ? `うち除外${formatCount(stats.excludedCount)}件` : undefined
        }
      />
      <StatCard label={config.keyMomentLabel} value={config.keyMomentValue} valueClassName="text-accent" />
      <StatCard
        label="最大クラスタ"
        value={stats.largestCluster?.name ?? "—"}
        hint={stats.largestCluster ? `${formatCount(stats.largestCluster.count)}件` : undefined}
      />
      <StatCard
        label="ピーク帯"
        value={peakRangeLabel}
        hint={peak ? `${formatCount(peak.total)}件/${binWidthLabel(binMinutes)}` : undefined}
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
