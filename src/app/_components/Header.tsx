import { formatCount } from "@/lib/view";

/**
 * ヘッダー(design.md §6.1)。稼働ドットの明滅は「データが継続収集されている」ことの表現なので、
 * 収集終了後(§9)は静止した灰色ドットに切り替え、終了メッセージを明示する。
 * 本震の日付・イベント名はこのサイトが単一イベント固定のモニタである(spec.md §1)ため、
 * クラスタや件数と違って動的に算出せず、意図的に文言として固定している。
 */
type HeaderProps = {
  periodLabel: string;
  totalNotes: number;
  updatedAtLabel: string | null;
  monitoringEnded: boolean;
};

export function Header({ periodLabel, totalNotes, updatedAtLabel, monitoringEnded }: HeaderProps) {
  return (
    <header className="flex flex-col gap-2">
      <div className="eyebrow flex items-center gap-2 text-accent">
        <span
          aria-hidden
          className={`inline-block size-1.5 rounded-full ${
            monitoringEnded ? "bg-label" : "bg-accent pulse-dot"
          }`}
        />
        <span className={monitoringEnded ? "text-label" : "text-accent"}>
          BirdXplorer 誤情報モニタリング
        </span>
      </div>
      <h1 className="text-[24px] font-bold tracking-tight text-heading sm:text-[30px]">
        熊本地震（2026/07/28）誤情報タイムライン
      </h1>
      <p className="text-[12px] text-muted sm:text-[13px]">
        対象期間 {periodLabel} ・ 集計 {formatCount(totalNotes)}件
        {updatedAtLabel ? ` ・ 最終更新 ${updatedAtLabel}` : ""}
      </p>
      {monitoringEnded && (
        <p className="tabular text-[12px] text-label">2026年8月31日で収集を終了しました</p>
      )}
    </header>
  );
}
