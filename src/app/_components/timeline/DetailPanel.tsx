import { hhmm, mmdd } from "@/lib/time";
import { statusLabel, type ViewNote } from "@/lib/view";
import { SearchlightBadges } from "./SearchlightBadges";

/**
 * 詳細パネル(design.md §6.5)。
 * 集約前の実クラスタ名を表示する(グラフ・凡例は「その他」に畳むが、ここでは畳まない)。
 */
export function DetailPanel({
  binStartAt,
  binEndAt,
  notes,
}: {
  binStartAt: number;
  binEndAt: number;
  notes: ViewNote[];
}) {
  return (
    <section className="rounded-xl border border-line bg-card p-4 sm:p-5" aria-live="polite">
      <h3 className="tabular text-[14px] font-semibold text-heading">
        {mmdd(binStartAt)} {hhmm(binStartAt)} 〜 {hhmm(binEndAt)}
        <span className="ml-2 font-sans text-[12px] font-normal text-muted">
          に付与されたNote（{notes.length}件）
        </span>
      </h3>

      {notes.length === 0 ? (
        <p className="mt-4 text-[13px] text-label">この時間帯に該当するNoteはありません。</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2.5">
          {notes.map((note) => (
            <li key={note.noteId} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-start gap-2.5 sm:flex-nowrap">
                <span className="tabular w-10 shrink-0 pt-0.5 text-[11px] text-label">
                  {hhmm(note.createdAt)}
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1 pt-0.5">
                  {note.cluster ? (
                    <span
                      className="tabular inline-flex items-center gap-1 rounded text-[10px]"
                      style={{
                        backgroundColor: `${note.cluster.color}22`,
                        color: "var(--color-body)",
                        padding: "1px 6px",
                      }}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: note.cluster.color }}
                      />
                      {note.cluster.name}
                    </span>
                  ) : (
                    <span className="tabular rounded bg-block px-1.5 py-0.5 text-[10px] text-annotation">
                      未分類
                    </span>
                  )}
                  {note.currentStatus && (
                    <span className="tabular rounded bg-block px-1.5 py-0.5 text-[10px] text-muted">
                      {statusLabel(note.currentStatus)}
                    </span>
                  )}
                  {note.excluded && (
                    <span className="tabular rounded bg-block px-1.5 py-0.5 text-[10px] text-annotation">
                      除外
                    </span>
                  )}
                </span>
                {/*
                  スマホ幅では時刻・バッジ等の shrink-0 要素が幅を固定的に消費するため、
                  本文を通常の flex-1 のまま同じ行に収めようとすると本文の描画幅だけが
                  極端に狭くなり、折り返し行数が増えて縦に間延びする。
                  flex-[0_0_100%] で本文を行全体の幅に強制し、親の flex-wrap と組み合わせて
                  本文だけを独立した行に折り返す(デスクトップは3カラム横並びのまま変更しない)。
                */}
                <p className="min-w-0 flex-[0_0_100%] text-[13px] leading-[1.7] text-body sm:flex-1">
                  {note.summary}
                </p>
                {note.searchlight && (
                  <span className="shrink-0 pt-0.5">
                    <SearchlightBadges badge={note.searchlight} />
                  </span>
                )}
                <a
                  href={note.postUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 pt-0.5 text-[11px] text-label transition-colors hover:text-body"
                  style={{ transitionDuration: "150ms" }}
                >
                  Xで見る
                </a>
              </div>
              {/*
                管理ビュー(?showExcluded=1)で除外ノートを開いたときだけ adminInfo が値を持つ
                (src/lib/view.ts の toViewNotes 参照)。spec.md §4 Stage1「スコア・理由を確認でき、
                閾値のチューニング検証に使う」を満たすための行。本文相当の情報のため
                text-weak(#4B5563, 対白7.56:1)を使い、注釈インク(#9AA3AF)は使わない。
              */}
              {note.adminInfo && (
                <p className="pl-[52px] text-[11px] leading-[1.5] text-weak">
                  <span className="tabular">スコア {note.adminInfo.relevance}</span>
                  {note.adminInfo.excludeReason && <span> ・ {note.adminInfo.excludeReason}</span>}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
