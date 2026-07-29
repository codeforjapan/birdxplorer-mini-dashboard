import { mmddhhmm } from "@/lib/time";
import type { ViewNote } from "@/lib/view";

/**
 * クラスタ別Note一覧(design.md §6.6)。
 *
 * 詳細パネル(§6.5)が「選択中の時間帯」を軸にノートを並べるのに対し、こちらは
 * 「クラスタ」を軸に並べ替えた相補的なビュー。クラスタは複数日にまたがりうるため、
 * 各ノートの見出しには日付を含む(§6.5のビン見出しのように日付を親側で示せないため)。
 *
 * `notes` はページ側で resolveClusterId 済みの ViewNote (toViewNotes の出力)。
 * グラフ・凡例は9位以下のクラスタを「その他」に集約するが(§3)、ここでは集約前の
 * 実クラスタ単位でグルーピングするため、「その他」に畳まれるクラスタも個別の行として
 * 現れる(意図的な差異。畳むのは表示スペースが限られるグラフ・凡例だけでよい)。
 */

/**
 * clusterId が null のノート用の疑似クラスタID。
 *
 * Stage1(関連性判定)で閾値未満と判定されたノートは、Stage2(クラスタ割当)に進めず
 * clusterId: null で確定する(src/app/api/cron/ingest/classify.ts)。つまり excluded な
 * ノートは実質的にすべて無所属になる。ここで弾いてしまうと `?showExcluded=1` で
 * 除外ノートを開いても件数が増えず「除外ノートを見る」というこのフラグの目的を
 * 果たせないため、詳細パネル(§6.5)と同じ「未分類」という1つの行にまとめて必ず表示する。
 */
const UNCLASSIFIED_ID = "__unclassified__";
const UNCLASSIFIED_NAME = "未分類";
const UNCLASSIFIED_COLOR = "var(--color-annotation)";

type ClusterGroup = {
  id: string;
  name: string;
  color: string;
  notes: ViewNote[];
};

function groupByCluster(notes: readonly ViewNote[]): ClusterGroup[] {
  const groups = new Map<string, ClusterGroup>();
  for (const note of notes) {
    const key = note.cluster?.id ?? UNCLASSIFIED_ID;
    const existing = groups.get(key);
    if (existing) {
      existing.notes.push(note);
    } else {
      groups.set(key, {
        id: key,
        name: note.cluster?.name ?? UNCLASSIFIED_NAME,
        color: note.cluster?.color ?? UNCLASSIFIED_COLOR,
        notes: [note],
      });
    }
  }

  const list = [...groups.values()];
  for (const g of list) g.notes.sort((a, b) => b.createdAt - a.createdAt); // 新しい順
  // 件数降順。同数はクラスタIDで並びを固定し、再レンダーでの入れ替わりを防ぐ。
  //
  // localeCompare は使わない。ICU データに依存するためサーバー(Node)とブラウザで
  // 比較結果が異なりうる。1件だけのクラスタが多数並ぶこの一覧では順序が入れ替わり、
  // 「server rendered text didn't match」のハイドレーション不一致を引き起こす。
  // コードポイント順の素朴な比較は環境に依存しない。
  list.sort((a, b) => b.notes.length - a.notes.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

export function ClusterNoteList({ notes }: { notes: ViewNote[] }) {
  const groups = groupByCluster(notes);

  return (
    <section className="rounded-xl border border-line bg-card p-4 sm:p-5">
      <h2 className="text-[14px] font-semibold text-heading">クラスタ別Note一覧</h2>

      {groups.length === 0 ? (
        <p className="mt-4 text-[13px] text-label">該当するNoteはありません。</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {groups.map((g) => (
            <li key={g.id} className="border-b border-line last:border-b-0">
              {/*
                <details>/<summary> はネイティブに aria-expanded 相当の状態・キーボード
                操作(Enter/Space)・トリガーと展開領域の関連付けを提供するため、
                手書きのARIAより優先して使う(design.md §10)。name属性は付けない
                (付けるとブラウザネイティブのアコーディオン排他制御が働き、
                「複数クラスタを同時に開ける」という要件(§6.6)を壊すため)。
              */}
              <details className="group/row">
                <summary
                  className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-2 outline-none transition-colors hover:bg-block"
                  style={{ transitionDuration: "150ms" }}
                >
                  <span
                    aria-hidden
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: g.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-body">{g.name}</span>
                  <span className="tabular shrink-0 text-[11px] text-label">{g.notes.length}件</span>
                </summary>

                {g.notes.length === 0 ? (
                  <p className="mt-1 mb-2 pl-[18px] text-[13px] text-label">
                    このクラスタに該当するNoteはありません。
                  </p>
                ) : (
                  <ul className="mt-1 mb-3 flex flex-col gap-1 pl-[18px]">
                    {g.notes.map((note) => (
                      <li key={note.noteId} className="flex flex-col gap-1">
                        <div className="flex items-start gap-2.5">
                          <span className="tabular w-[76px] shrink-0 pt-0.5 text-[11px] text-label">
                            {mmddhhmm(note.createdAt)}
                          </span>
                          {/*
                            管理ビュー(?showExcluded=1)で除外ノートを開いたときだけ adminInfo が
                            値を持つ(src/lib/view.ts参照)。「未分類」への集約だけでは除外された
                            ものだと一目でわからないため、明示の「除外」ラベルを併記する。
                          */}
                          {note.adminInfo && (
                            <span className="tabular mt-0.5 shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-weak">
                              除外
                            </span>
                          )}
                          <p className="min-w-0 flex-1 text-[13px] leading-[1.7] text-body">
                            {note.summary}
                          </p>
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
                          spec.md §4 Stage1「スコア・理由を確認でき、閾値のチューニング検証に使う」を
                          満たす行。本文相当の情報のため text-weak(#4B5563, 対白7.56:1)を使う。
                        */}
                        {note.adminInfo && (
                          <p className="pl-[86px] text-[11px] leading-[1.5] text-weak">
                            <span className="tabular">スコア {note.adminInfo.relevance}</span>
                            {note.adminInfo.excludeReason && (
                              <span> ・ {note.adminInfo.excludeReason}</span>
                            )}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
