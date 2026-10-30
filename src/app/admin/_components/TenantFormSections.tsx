"use client";

import type { ReactNode } from "react";
import { isPresetValue, type TenantFormValues } from "@/lib/admin/form";
import { TENANT_PRESETS } from "@/lib/tenant/presets";
import type { Taxonomy, TenantTypeId } from "@/lib/tenant/types";

export type FormSection = "basic" | "period" | "taxonomy" | "display" | "all";

type Props = {
  values: TenantFormValues;
  onChange: (next: TenantFormValues) => void;
  errors: Record<string, string>;
  section: FormSection;
  slugEditable: boolean;
};

const INPUT = "w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-[13px] text-heading";
const SMALL_BTN = "rounded border border-line px-2 py-1 text-[12px] text-body hover:text-heading";

const TYPE_FLAVOR: Record<TenantTypeId, string> = { disaster: "熊本", election: "沖縄" };

const TAXONOMY_FIELDS: { key: keyof Taxonomy; label: string; rows: number }[] = [
  { key: "searchTermExamples", label: "検索語の例", rows: 2 },
  { key: "relevantExamples", label: "関連ありの例", rows: 8 },
  { key: "irrelevantExamples", label: "関連なしの例", rows: 5 },
  { key: "clusterNamingGoodExamples", label: "クラスタ命名の良い例（複数）", rows: 2 },
  { key: "clusterNamingBadExamples", label: "クラスタ命名の悪い例（複数）", rows: 2 },
  { key: "clusterNamingGoodExampleSingle", label: "クラスタ命名の良い例（1件）", rows: 1 },
  { key: "clusterNamingBadExampleSingle", label: "クラスタ命名の悪い例（1件）", rows: 1 },
  { key: "overMergeCounterExample", label: "統合してはいけない例", rows: 6 },
  { key: "namingNeutralityRule", label: "命名の中立規約（選挙型のみ）", rows: 4 },
];

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] font-semibold text-strong">
      {label}
      {children}
      {hint !== undefined && <span className="text-[12px] font-normal text-muted">{hint}</span>}
      {error !== undefined && <span className="text-[12px] font-normal text-accent">{error}</span>}
    </label>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
      <h2 className="text-[15px] font-bold text-heading">{title}</h2>
      {children}
    </section>
  );
}

export function TenantFormSections({ values, onChange, errors, section, slugEditable }: Props) {
  const show = (s: FormSection) => section === "all" || section === s;
  const set = <K extends keyof TenantFormValues>(key: K, v: TenantFormValues[K]) =>
    onChange({ ...values, [key]: v });
  const text = (key: keyof TenantFormValues & string, label: string, hint?: ReactNode) => (
    <Field label={label} error={errors[key]} hint={hint}>
      <input
        className={INPUT}
        value={values[key] as string}
        onChange={(e) => set(key, e.target.value as never)}
      />
    </Field>
  );
  const preset = TENANT_PRESETS[values.type];

  // 型を替えたとき、まだ旧型の既定のままの欄だけ新しい型の既定へ追従させる
  const changeType = (type: TenantTypeId) => {
    const oldP = TENANT_PRESETS[values.type];
    const newP = TENANT_PRESETS[type];
    const taxonomy = { ...values.taxonomy };
    for (const f of TAXONOMY_FIELDS) {
      if (taxonomy[f.key] === oldP.taxonomy[f.key]) (taxonomy[f.key] as string | null) = newP.taxonomy[f.key];
    }
    onChange({
      ...values,
      type,
      taxonomy,
      relevanceMode: values.relevanceMode === oldP.relevanceMode ? newP.relevanceMode : values.relevanceMode,
      relevanceThreshold:
        values.relevanceThreshold === oldP.relevanceThreshold ? newP.relevanceThreshold : values.relevanceThreshold,
      binMinutes: values.binMinutes === oldP.binMinutes ? newP.binMinutes : values.binMinutes,
    });
  };

  const setNumber = (key: "relevanceThreshold" | "binMinutes", raw: string) =>
    set(key, (raw === "" ? NaN : Number(raw)) as never);
  const numValue = (n: number) => (Number.isNaN(n) ? "" : String(n));

  return (
    <div className="flex flex-col gap-4">
      {errors._form !== undefined && (
        <p role="alert" className="rounded-md border border-accent px-3 py-2 text-[13px] text-accent">
          {errors._form}
        </p>
      )}

      {show("basic") && (
        <Block title="基本">
          {text("siteTitle", "サイトタイトル", "公開ページの見出しとブラウザのタブに出ます")}
          <Field
            label="slug"
            error={errors.slug}
            hint={slugEditable ? "URL に使う識別子（英小文字・数字・ハイフン）。作成後は変えられません" : undefined}
          >
            {slugEditable ? (
              <input
                className={`${INPUT} tabular`}
                value={values.slug}
                onChange={(e) => set("slug", e.target.value)}
              />
            ) : (
              <span className="tabular text-[13px] font-normal text-heading">{values.slug}</span>
            )}
          </Field>
          <Field label="型" error={errors.type}>
            <select
              className={INPUT}
              value={values.type}
              onChange={(e) => changeType(e.target.value as TenantTypeId)}
            >
              {(Object.keys(TENANT_PRESETS) as TenantTypeId[]).map((t) => (
                <option key={t} value={t}>
                  {TENANT_PRESETS[t].label}
                </option>
              ))}
            </select>
          </Field>
        </Block>
      )}

      {show("period") && (
        <Block title="期間と検索語">
          <Field label="開始日時（JST）" error={errors.monitorStartAt}>
            <input
              type="datetime-local"
              className={INPUT}
              value={values.monitorStartAt}
              onChange={(e) => set("monitorStartAt", e.target.value)}
            />
          </Field>
          <Field label="終了日（JST）" error={errors.monitorEndDate}>
            <input
              type="date"
              className={INPUT}
              value={values.monitorEndDate}
              onChange={(e) => set("monitorEndDate", e.target.value)}
            />
          </Field>
          <Field label="検索語（1行に1語）" error={errors.searchKeywords}>
            <textarea
              className={INPUT}
              rows={6}
              value={values.searchKeywords}
              onChange={(e) => set("searchKeywords", e.target.value)}
            />
          </Field>
        </Block>
      )}

      {show("taxonomy") && (
        <Block title="分類の例文">
          <p className="text-[12px] text-muted">空にすると型の既定（{preset.label}）を使います。</p>
          {TAXONOMY_FIELDS.map(({ key, label, rows }) => {
            const atPreset = isPresetValue(values, key);
            return (
              <Field key={key} label={label} error={errors[`taxonomy.${key}`]}>
                <textarea
                  className={INPUT}
                  rows={rows}
                  value={values.taxonomy[key] ?? ""}
                  onChange={(e) => set("taxonomy", { ...values.taxonomy, [key]: e.target.value })}
                />
                <span className="flex items-center gap-2 text-[12px] font-normal text-muted">
                  {atPreset ? (
                    <span>型の既定のまま（{TYPE_FLAVOR[values.type]}の文言）</span>
                  ) : (values.taxonomy[key] ?? "").trim() === "" ? (
                    // 保存時は空を「上書きなし」として扱うので、表示もそれに揃える
                    <span>空のため型の既定（{TYPE_FLAVOR[values.type]}の文言）を使います</span>
                  ) : (
                    <button
                      type="button"
                      className={SMALL_BTN}
                      onClick={() => set("taxonomy", { ...values.taxonomy, [key]: preset.taxonomy[key] })}
                    >
                      既定に戻す
                    </button>
                  )}
                </span>
              </Field>
            );
          })}
          <Field label="関連性の方式" error={errors.relevanceMode}>
            <select
              className={INPUT}
              value={values.relevanceMode}
              onChange={(e) => set("relevanceMode", e.target.value as TenantFormValues["relevanceMode"])}
            >
              <option value="score">点数（しきい値以上を残す）</option>
              <option value="binary">関連あり／なしの2択</option>
            </select>
          </Field>
          <Field
            label="しきい値（0〜100）"
            error={errors.relevanceThreshold}
            hint={`この点数以上のノートを残します。点数方式のときだけ使います。既定 ${preset.relevanceThreshold}`}
          >
            <input
              type="number"
              className={`${INPUT} tabular`}
              value={numValue(values.relevanceThreshold)}
              onChange={(e) => setNumber("relevanceThreshold", e.target.value)}
            />
          </Field>
          <Field label="グラフの集計単位（分）" error={errors.binMinutes} hint={`既定 ${preset.binMinutes}`}>
            <input
              type="number"
              className={`${INPUT} tabular`}
              value={numValue(values.binMinutes)}
              onChange={(e) => setNumber("binMinutes", e.target.value)}
            />
          </Field>
        </Block>
      )}

      {show("display") && (
        <Block title="表示まわり">
          <Field label="サイトの説明" error={errors.siteDescription} hint="検索結果や SNS で共有したときに出る説明文">
            <textarea
              className={INPUT}
              rows={3}
              value={values.siteDescription}
              onChange={(e) => set("siteDescription", e.target.value)}
            />
          </Field>
          {text("eyebrowLabel", "見出しの上の小さなラベル", "例: BirdXplorer コミュニティノート観測")}
          {text("scheduleLabel", "見出しの下の日時", "空でも可。例: 2026年7月28日 16:27 発生（M7.1）")}

          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-semibold text-strong">グラフに引く縦線（主な出来事）</p>
            <p className="text-[12px] text-muted">時系列グラフに縦線と文言を出します。例: 本震 16:27</p>
            {errors.keyMoments !== undefined && <p className="text-[12px] text-accent">{errors.keyMoments}</p>}
            {values.keyMoments.map((k, i) => (
              <div key={i} className="flex flex-col gap-1 rounded-md border border-line p-2">
                <div className="flex items-center gap-2">
                  <input
                    type="datetime-local"
                    aria-label="縦線の日時（JST）"
                    className={INPUT}
                    value={k.at}
                    onChange={(e) =>
                      set(
                        "keyMoments",
                        values.keyMoments.map((m, j) => (j === i ? { ...m, at: e.target.value } : m)),
                      )
                    }
                  />
                  <input
                    className={INPUT}
                    aria-label="縦線の文言"
                    placeholder="マーカーの文言"
                    value={k.markerLabel}
                    onChange={(e) =>
                      set(
                        "keyMoments",
                        values.keyMoments.map((m, j) => (j === i ? { ...m, markerLabel: e.target.value } : m)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className={SMALL_BTN}
                    onClick={() =>
                      set(
                        "keyMoments",
                        values.keyMoments.filter((_, j) => j !== i),
                      )
                    }
                  >
                    削除
                  </button>
                </div>
                {errors[`keyMoments.${i}.at`] !== undefined && (
                  <p className="text-[12px] text-accent">{errors[`keyMoments.${i}.at`]}</p>
                )}
                {errors[`keyMoments.${i}.markerLabel`] !== undefined && (
                  <p className="text-[12px] text-accent">{errors[`keyMoments.${i}.markerLabel`]}</p>
                )}
              </div>
            ))}
            <button
              type="button"
              className={`${SMALL_BTN} self-start`}
              onClick={() => set("keyMoments", [...values.keyMoments, { at: "", markerLabel: "" }])}
            >
              ＋ 行を足す
            </button>
          </div>
          {text("keyMomentLabel", "数字カードの見出し", "総ノート数の隣に出るカード。空でも可。例: 本震")}
          {text("keyMomentValue", "数字カードの値", "例: M7.1 / 16:27")}

          <p className="text-[12px] text-muted">
            AI がノートを判定・分類するときに伝える事例名です。公開ページには出ません。同じ事例を3つの長さで書きます。
          </p>
          {text("llmContextPhrase", "AI に伝える事例名（正式）", "関連性の判定に使います。例: 2026年7月28日に発生した熊本地震")}
          {text("llmContextPhraseCompact", "AI に伝える事例名（短め）", "分類とレポートに使います。例: 2026年7月28日の熊本地震")}
          {text("llmContextPhraseShort", "AI に伝える事例名（最短）", "例: 熊本地震")}

          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-semibold text-strong">フッターの公式情報リンク</p>
            {text("officialSourcesIntro", "前置き", "リンクの前に置く文。例: 地震・被害・避難に関する一次情報は")}
            {errors.officialSources !== undefined && <p className="text-[12px] text-accent">{errors.officialSources}</p>}
            {values.officialSources.map((s, i) => (
              <div key={i} className="flex flex-col gap-1 rounded-md border border-line p-2">
                <div className="flex items-center gap-2">
                  <input
                    className={INPUT}
                    aria-label="リンクの名称"
                    placeholder="名称"
                    value={s.label}
                    onChange={(e) =>
                      set(
                        "officialSources",
                        values.officialSources.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className={INPUT}
                    aria-label="リンクの URL"
                    placeholder="https://"
                    value={s.url}
                    onChange={(e) =>
                      set(
                        "officialSources",
                        values.officialSources.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className={SMALL_BTN}
                    onClick={() =>
                      set(
                        "officialSources",
                        values.officialSources.filter((_, j) => j !== i),
                      )
                    }
                  >
                    削除
                  </button>
                </div>
                {errors[`officialSources.${i}.label`] !== undefined && (
                  <p className="text-[12px] text-accent">{errors[`officialSources.${i}.label`]}</p>
                )}
                {errors[`officialSources.${i}.url`] !== undefined && (
                  <p className="text-[12px] text-accent">{errors[`officialSources.${i}.url`]}</p>
                )}
              </div>
            ))}
            <button
              type="button"
              className={`${SMALL_BTN} self-start`}
              onClick={() => set("officialSources", [...values.officialSources, { label: "", url: "" }])}
            >
              ＋ 行を足す
            </button>
          </div>
          {text("officialSourcesDisclaimer", "注意書き", "例: 本サイトは防災情報を提供するものではありません。")}

          <p className="text-[12px] font-semibold text-strong">詳細（通常は変えない）</p>
          {text("issuesUrl", "不具合報告先の URL", "フッターの「GitHub Issues」のリンク先")}
          {text("githubRepo", "GitHub リポジトリ（owner/repo）", "AI 利用料の集計で使う識別子")}
          {text("appTitle", "アプリ名（半角英数）", "AI 利用料の集計で使う識別子")}
        </Block>
      )}
    </div>
  );
}
