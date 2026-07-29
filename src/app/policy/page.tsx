import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ポリシー | コミュニティノートタイムライン 令和8年熊本地震",
  description: "データの収集範囲・匿名化の限界・AI生成レポートの位置づけ・訂正依頼の窓口について。",
};

/** 誤分類・レポートの誤り・削除依頼の受付経路(spec.md §8-8)。Footer と同じURL。 */
const ISSUES_URL = "https://github.com/codeforjapan/kumamoto-earthquake-dashboard/issues";

/**
 * ポリシーページ(spec.md §11 手順8、§8-3)。
 *
 * ここは広報文ではなく、限界を含めて事実をそのまま書く場所と位置づけている。
 * とくに匿名化については「Xポストへのリンクを併記しているため、匿名化は識別を
 * 遅らせるだけで防ぐものではない」という、仕様上意図的に受容したリスクを
 * 誇張も矮小化もせずに書く(§8-3: 「意図的な設計判断として明記」)。
 */
export default function PolicyPage() {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <div>
        <div className="eyebrow text-label">POLICY</div>
        <h1 className="mt-1 text-[24px] font-bold tracking-tight text-heading sm:text-[30px]">
          データの取り扱いについて
        </h1>
        <p className="mt-2 text-[13px] leading-[1.7] text-muted">
          本サイト(コミュニティノートタイムライン 令和8年熊本地震)が何を収集し、どう扱っているかを説明する。
          運用上の限界も含めて、実際の挙動をそのまま記載する。
        </p>
      </div>

      <Section title="このサイトについて">
        <p>
          令和8年熊本地震(2026年7月28日 16:27 発生、M7.1)に関する、X(旧Twitter)コミュニティノートを
          継続的に収集し、LLM(大規模言語モデル)によって内容ごとに動的に分類したうえで
          時系列グラフとレポートとして公開する、単一イベント固定の観測サイトである。
          恒常的な監視サービスではなく、下記の運用期間に限定して稼働する。
          運営は一般社団法人コード・フォー・ジャパンである。
        </p>
        <p>
          扱うのは<strong className="text-heading">コミュニティノートという「指摘があったという事実」であり、
          元の投稿が虚偽であるという判定ではない</strong>。コミュニティノートはXの利用者が投稿し、
          Xの評価プロセスを経て表示されるものであって、本サイトの収集対象には
          「評価不足」「有用でない」と評価されたノートも含まれる。ノートが付いていることを
          元投稿が誤りである証拠として扱わないでほしい。
        </p>
      </Section>

      <Section title="収集するデータ">
        <p>
          データの取得元は BirdXplorer(X コミュニティノートを収集・提供する
          外部API、認証不要のエンドポイントを利用)である。取得したノートのうち、
          以下のフィールドのみを保存・公開する。
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>ノート本文(コミュニティノートの要約テキスト)</li>
          <li>ノートの投稿日時</li>
          <li>評価状態(有用/有用でない/評価不足など)と評価件数</li>
          <li>元のXポストへのリンク</li>
          <li>拡散規模の目安(インプレッション数)</li>
        </ul>
        <p>
          一方で、<strong className="text-heading">Xポスト本文そのものはLLMによる分類処理の入力として
          一時的にメモリ上で使うだけで、処理後は破棄し、公開サイトのデータには一切保存しない</strong>。
          投稿者に関する情報(表示名・ユーザーID・プロフィール画像・フォロワー数など)も
          取得時点で一切保存しない。
        </p>
      </Section>

      <Section title="匿名化について、正直な限界">
        <p>
          ノートの投稿者情報は保存・表示しない。ただし、<strong className="text-heading">
          各ノートには元のXポストへのリンクをそのまま併記している</strong>。
          そのリンクを開けば、投稿者が誰であるかは通常1クリックで判明する。
        </p>
        <p>
          したがって、この匿名化は投稿者の特定を防ぐものではなく、
          <strong className="text-heading">特定に至るまでの手間をわずかに増やすだけの、速度制限に過ぎない</strong>。
          これは実装上の見落としではなく、コミュニティノートという仕組み自体が
          公開のXポストに紐づく以上、リンクなしにはノートの文脈(何についての指摘か)を
          示せないという制約のもとで、あえて許容した設計判断である。
          より強い匿名化を望む場合、このサイトはその要件を満たさない。
        </p>
      </Section>

      <Section title="関連性の判定と除外ノート">
        <p>
          「熊本」「地震」「津波」等のキーワードで収集したノートには、地震と無関係な
          投稿(医療デマやアニメ関連の話題など)が混入するため、LLMが0〜100の関連性スコアを
          付与し、60未満のノートは「除外」として公開のグラフ・統計からは外す。
          ただしデータそのものを削除するわけではなく、<code className="rounded bg-block px-1 py-0.5 text-[12px]">
          ?showExcluded=1</code> を付けたURLで、除外されたノートとその判定理由を含めて閲覧できる。
        </p>
      </Section>

      <Section title="レポートはすべてAIが自動生成している">
        <p>
          日次ダイジェスト・累積レポートはいずれも、人手による確認・修正を一切経ずに
          LLMが自動生成し、そのまま公開している。誤った要約、事実と異なる記述、
          文脈の欠落が含まれる可能性がある。
        </p>
        <p>
          内容を鵜呑みにせず、一次情報として元のXポストを確認したうえで判断してほしい。
          そのうえで誤りを見つけた場合は、下記の窓口から指摘してほしい。
        </p>
        <p>
          なお、継ぎ足しで更新される累積レポートは、要約が重なるたびに誤りが
          運ばれ歪んでいく可能性があるため、各日の確定済みダイジェスト(
          <Link href="/" className="underline decoration-line underline-offset-2 hover:text-strong">
            トップページ
          </Link>
          の「日次アーカイブ」から個別に参照可能)を一次記録として残している。
          累積側の要約が信頼できないと感じた場合は、そちらを確認してほしい。
        </p>
      </Section>

      <Section title="訂正・削除依頼の窓口">
        <p>
          分類の誤り、レポート内の誤った記述、掲載しているノートの削除依頼は、
          <a
            href={ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-line underline-offset-2 hover:text-strong"
          >
            GitHub Issues
          </a>
          で受け付ける。
        </p>
        <p>
          ただし窓口があることは、公開前に人手で検証していることを意味しない。
          レポートは無検証で公開され、指摘は<strong className="text-heading">事後の対応</strong>となる。
          対応までの時間や、すべての指摘に応じられることを保証するものではない。
        </p>
      </Section>

      <Section title="災害の一次情報について">
        <p>
          本サイトは防災情報を提供するものではない。地震・被害・避難に関する情報は、
          気象庁および熊本県・各市町村の発表を確認してほしい。
        </p>
      </Section>

      <Section title="運用期間">
        <p>
          公開開始は2026年7月28日、<strong className="text-heading">運用終了は2026年8月31日</strong>を
          予定している。それ以降は新規データの収集・レポート生成を自動的に停止し、
          サイトはそれまでの内容を静的なアーカイブとして残す。
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[14px] font-semibold text-heading">{title}</h2>
      <div className="flex flex-col gap-2 text-[13px] leading-[1.7] text-body [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1">
        {children}
      </div>
    </section>
  );
}
