import type { DisplayCluster } from "@/lib/view";

/**
 * 凡例チップ(design.md §6.4)。クリックで該当クラスタを強調し、他クラスタをグラフ上で
 * 不透明度12%に落とす。色だけを情報の担い手にしないよう、常にクラスタ名をテキストで併記する(§10)。
 */
export function Legend({
  legend,
  highlightedClusterId,
  onToggle,
}: {
  legend: DisplayCluster[];
  highlightedClusterId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="クラスタの凡例。クリックで強調表示を切り替えられます。">
      {legend.map((c) => {
        const isSelected = highlightedClusterId === c.id;
        const isDimmed = highlightedClusterId !== null && !isSelected;
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onToggle(c.id)}
              aria-pressed={isSelected}
              className="tabular flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors"
              style={{
                borderColor: isSelected ? c.color : "var(--color-line)",
                backgroundColor: isSelected ? `${c.color}22` : "transparent",
                color: isDimmed ? "var(--color-annotation)" : "var(--color-body)",
                transitionDuration: "150ms",
              }}
            >
              <span
                aria-hidden
                className="inline-block size-2 rounded-[2px]"
                style={{ backgroundColor: c.color }}
              />
              <span>{c.name}</span>
              <span style={{ color: "var(--color-label)" }}>{c.count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
