import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { OTHER_CLUSTER_COLOR } from "@/lib/constants";
import { mmdd } from "@/lib/time";
import type { DisplayCluster } from "@/lib/view";

/**
 * レポートセクション(design.md §6.7)。
 *
 * ダイジェストの Markdown 構造は自由形式の散文ではなく、生成側(src/lib/llm/report.ts)と
 * 描画側で共有する契約(src/lib/llm/contract.ts の DIGEST_SUMMARY_HEADING 付近)である。
 * 「## クラスタ別まとめ」の直下に並ぶ「### {連番}. {クラスタ名}（{件数}件）」は、
 * 見出しの**構造上の位置**によってクラスタブロックだと確定する。クラスタ名の文字列が
 * 現在のクラスタ一覧と解決できるかどうかは、色とバッジという**装飾の一部**を左右するに
 * すぎず、ブロックとして描画するかどうかには関与しない。
 *
 * これは「レポートはある時点のスナップショットであり、その後 recluster でクラスタ名が
 * 変わったり件数が変わったりする」という運用実態への対応でもある(spec.md §4 Stage 3)。
 * 名前が変わって解決できなくなったクラスタも、構造上はクラスタブロックのままである
 * べきで、装飾抜けの理由にしてはならない。
 *
 * remark の AST を使わず文字列分割で済ませているのは、「## / ### 見出し + 本文」という
 * 素朴な構造さえ守られていれば十分なため、過剰にリッチなパーサを書く必要がないという判断。
 */

/** 「## クラスタ別まとめ」直下に並ぶクラスタ見出し(§6.7)。契約上、本文を持たない。 */
const CLUSTER_SUMMARY_HEADING = "クラスタ別まとめ";

type Section = { level: 2 | 3 | null; heading: string | null; body: string };

function splitSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: { level: 2 | 3 | null; heading: string | null; body: string[] }[] = [
    { level: null, heading: null, body: [] },
  ];
  for (const line of lines) {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (m) {
      sections.push({ level: m[1].length as 2 | 3, heading: m[2].trim(), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }
  return sections
    .map((s) => ({ level: s.level, heading: s.heading, body: s.body.join("\n").trim() }))
    .filter((s) => s.heading !== null || s.body !== "");
}

/**
 * 見出し文字列からクラスタ名照合用の部分を取り出す。
 *
 * 契約(contract.ts)上、見出しには先頭の連番("1. ")と末尾の件数("（22件）")が
 * 必ず付くため、これらは照合の妨げになるだけの装飾として取り除く。全角/半角の
 * 括弧どちらでも書かれうるため両方を許容する。単語の並べ替えや同義語には対応しない
 * (renameされた場合はそもそも名前解決を諦め、ブロック自体は§6.7の構造判定で描画する)。
 */
function cleanHeadingForMatch(heading: string): string {
  return heading
    .replace(/^[\s\d.．、,()（）]+/, "") // 先頭の連番・記号
    .replace(/[\s]*[（(]\s*\d+\s*件\s*[）)]\s*$/, "") // 末尾の(N件)/（N件）
    .trim();
}

/** 見出し文字列(先頭の連番・末尾の件数を除いた上で)がクラスタ名と対応するか判定する。 */
function matchCluster(heading: string, clusters: DisplayCluster[]): DisplayCluster | null {
  const cleaned = cleanHeadingForMatch(heading);
  if (!cleaned) return null;
  return clusters.find((c) => cleaned.includes(c.name) || c.name.includes(cleaned)) ?? null;
}

type AnnotatedSection = Section & {
  /** この見出しが「## クラスタ別まとめ」〜次の「##」の区間内にあるか(§6.7)。 */
  inClusterGroup: boolean;
};

/**
 * 各セクションに「クラスタ別まとめ区間内か」を付与する。
 *
 * コンポーネント本体の render 中に `let` 変数を書き換えながら`.map`するとReact
 * Compilerの purity チェック(react-hooks/immutability)に引っかかる(view.ts の
 * nowMs() 同様の理由)ため、区間判定は render の外側にある純粋関数として切り出す。
 */
function annotateClusterGroups(sections: Section[]): AnnotatedSection[] {
  let inClusterGroup = false;
  return sections.map((s) => {
    if (s.level === 2) {
      // 「まとめ」は「クラスタ別まとめ」を含んでしまう部分一致ではなく、契約通り
      // 完全一致で判定する(§6.7、DIGEST_SUMMARY_HEADING)。
      inClusterGroup = s.heading === CLUSTER_SUMMARY_HEADING;
    }
    return { ...s, inClusterGroup };
  });
}

const bodyComponents: Components = {
  p: ({ children }) => <p className="text-[13px] leading-[1.7] text-body">{children}</p>,
  strong: ({ children }) => <strong className="text-heading">{children}</strong>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-line underline-offset-2 hover:text-strong"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="text-[13px] leading-[1.7] text-body">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 text-weak">{children}</blockquote>
  ),
  code: ({ children }) => (
    <code className="tabular rounded bg-block px-1 py-0.5 text-[12px]">{children}</code>
  ),
};

/** クラスタブロック内の説明文だけは design.md §6.6 の指定色(弱め)にする。 */
const clusterBlockComponents: Components = {
  ...bodyComponents,
  p: ({ children }) => <p className="text-[13px] leading-[1.7] text-weak">{children}</p>,
};

/** まとめブロック: 各項目の冒頭語だけを白にする(design.md §6.6)。 */
const summaryComponents: Components = {
  ...bodyComponents,
  li: ({ children }) => {
    const items = Array.isArray(children) ? children : [children];
    const [first, ...rest] = items;
    if (typeof first === "string") {
      const boundary = first.indexOf(" ");
      const boundaryJa = boundary > 0 ? boundary : first.search(/[はがをにでともへ、]/);
      if (boundaryJa > 0) {
        const head = first.slice(0, boundaryJa);
        const tail = first.slice(boundaryJa);
        return (
          <li className="text-[13px] leading-[1.7] text-body">
            <strong className="text-heading">{head}</strong>
            {tail}
            {rest}
          </li>
        );
      }
    }
    return <li className="text-[13px] leading-[1.7] text-body">{children}</li>;
  },
};

export function ReportSection({
  title,
  metaLine,
  markdown,
  clusters,
  archiveDates,
}: {
  title: string;
  metaLine: string;
  markdown: string;
  clusters: DisplayCluster[];
  archiveDates: string[];
}) {
  const sections = annotateClusterGroups(splitSections(markdown));

  return (
    <section className="border-t border-line pt-8">
      <div className="eyebrow text-label">REPORT</div>
      <h2 className="mt-1 text-[16px] font-bold text-heading sm:text-[18px]">{title}</h2>
      <p className="tabular mt-1 text-[11px] text-label sm:text-[12px]">{metaLine}</p>
      {/* AI生成の明示は常時表示。折りたたまない(design.md §6.6)。 */}
      <p className="tabular mt-0.5 text-[11px] text-label sm:text-[12px]">
        このレポートはAIが自動生成しており、人手による検証を経ていません。
      </p>

      <div className="mt-5 flex flex-col gap-3">
        {sections.map((section, i) => {
          if (section.heading === null) {
            return (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={bodyComponents}>
                {section.body}
              </ReactMarkdown>
            );
          }

          if (section.level === 2) {
            if (/^(まとめ|総括)/.test(section.heading)) {
              // 本文が空なら(契約上は起きないはずだが)空カードを描画しない。
              if (section.body === "") return null;
              return (
                <div key={i} className="rounded-lg border border-line p-4">
                  <h3 className="mb-2 text-[14px] font-semibold text-heading">{section.heading}</h3>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={summaryComponents}>
                    {section.body}
                  </ReactMarkdown>
                </div>
              );
            }

            // 「クラスタ別まとめ」自体は契約上見出しのみで本文を持たない区切りなので、
            // 本文が空なら描画しない(空の見出しだけの行を残さない)。
            if (section.body === "") return null;

            return (
              <div key={i}>
                <h3 className="mb-1.5 text-[14px] font-semibold text-heading">{section.heading}</h3>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={bodyComponents}>
                  {section.body}
                </ReactMarkdown>
              </div>
            );
          }

          // section.level === 3。「クラスタ別まとめ」直下なら、名前解決の成否に関わらず
          // 構造上クラスタブロックとして描画する(§6.7)。renameで名前が解決できなくなった
          // 場合や、9位以下でグラフの上位8集約に含まれない場合でも、ここでは影響しない
          // (clusters には呼び出し側が全クラスタを渡す。src/lib/view.ts の
          // buildAllDisplayClusters を参照)。
          if (section.inClusterGroup) {
            const cluster = matchCluster(section.heading, clusters);
            // 名前が解決できないクラスタは色・件数バッジという「装飾」だけを諦め、
            // 左帯は「その他」集約と同じ中立色(#94A3B8 = OTHER_CLUSTER_COLOR)にする。
            // 件数バッジは誤った数字を出すくらいなら出さない方がよいため省略する(§6.7)。
            const barColor = cluster?.color ?? OTHER_CLUSTER_COLOR;
            return (
              <div
                key={i}
                className="rounded-lg bg-block"
                style={{ borderLeft: `4px solid ${barColor}`, padding: "14px 16px" }}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="tabular text-[10px] text-label">{String(i).padStart(2, "0")}</span>
                  <span className="text-[14px] font-semibold text-heading">{section.heading}</span>
                  {cluster && (
                    <span
                      className="tabular ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                      style={{ backgroundColor: `${cluster.color}22`, color: "var(--color-body)" }}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: cluster.color }}
                      />
                      {cluster.count}件
                    </span>
                  )}
                </div>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={clusterBlockComponents}>
                  {section.body}
                </ReactMarkdown>
              </div>
            );
          }

          return (
            <div key={i}>
              <h3 className="mb-1.5 text-[14px] font-semibold text-heading">{section.heading}</h3>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={bodyComponents}>
                {section.body}
              </ReactMarkdown>
            </div>
          );
        })}
      </div>

      {archiveDates.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <div className="tabular mb-2 text-[10px] uppercase tracking-wide text-label">
            日次アーカイブ
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {archiveDates.map((d) => (
              <li key={d}>
                <Link
                  href={`/report/${d}`}
                  className="tabular text-[12px] text-muted underline decoration-line underline-offset-2 hover:text-body"
                >
                  {mmdd(Date.parse(`${d}T00:00:00+09:00`))}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
