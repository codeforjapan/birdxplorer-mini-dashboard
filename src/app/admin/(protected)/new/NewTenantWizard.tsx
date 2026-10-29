"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { TenantFormSections } from "@/app/admin/_components/TenantFormSections";
import { createTenantAction } from "@/lib/admin/actions";
import { newFormValues, type TenantFormValues } from "@/lib/admin/form";
import {
  errorsForStep,
  firstStepWithError,
  parseDraft,
  STORAGE_KEY,
  validateForm,
  WIZARD_STEPS,
} from "@/lib/admin/wizard";
import { TENANT_PRESETS } from "@/lib/tenant/presets";

const BTN = "rounded-md border border-line px-4 py-2 text-[13px] text-body hover:text-heading disabled:opacity-50";

function storageGet(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storageSet(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 使えない環境では保存せず、そのまま続ける
  }
}

function storageClear(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}

export function NewTenantWizard() {
  const router = useRouter();
  const [values, setValues] = useState<TenantFormValues>(() => newFormValues("disaster"));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [publishFailed, setPublishFailed] = useState<{ slug: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  // ref だと StrictMode の再実行で、復元した値が描画される前に初期値で下書きを上書きする。
  // state なら復元した値と同じ描画で true になる
  const [restored, setRestored] = useState(false);
  // 作成後に下書きを書き戻すと、次に開いたとき作成済みの内容が復元される
  const [done, setDone] = useState(false);

  // SSR との不一致を避けるため、マウント後に読む
  useEffect(() => {
    const d = parseDraft(storageGet());
    /* eslint-disable react-hooks/set-state-in-effect -- localStorage はマウント後にしか読めない */
    if (d !== null) {
      setValues(d.values);
      setStep(d.step);
    }
    setRestored(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!restored || done) return;
    storageSet(JSON.stringify({ values, step }));
  }, [values, step, restored, done]);

  const current = WIZARD_STEPS[step];
  const isConfirm = current.id === "confirm";

  const goTo = (n: number) => {
    setErrors({});
    setNotice(null);
    setStep(n);
  };

  const next = () => {
    const stepErrors = errorsForStep(validateForm(values), current.id);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    goTo(step + 1);
  };

  const save = () => {
    setNotice(null);
    const all = validateForm(values);
    const first = firstStepWithError(all);
    if (first !== null) {
      const i = WIZARD_STEPS.findIndex((s) => s.id === first);
      setStep(i);
      setErrors(errorsForStep(all, first));
      setNotice("入力に誤りがあります。直してからもう一度進んでください");
      return;
    }
    setErrors({});
    startTransition(async () => {
      const r = await createTenantAction(values);
      if (r.ok) {
        setDone(true);
        storageClear();
        router.push(`/admin/${r.slug}`);
        return;
      }
      if (r.kind === "publish-failed") {
        // DB には下書きとして入っているので、ここから先は編集ページで扱う
        setDone(true);
        storageClear();
        setPublishFailed({ slug: values.slug, message: r.message });
        return;
      }
      if (r.kind === "exists") {
        setStep(0);
        setErrors({ slug: "この slug は使われています" });
        return;
      }
      if (r.kind === "invalid") {
        const fe = r.fieldErrors ?? {};
        const i = WIZARD_STEPS.findIndex((s) => s.id === (firstStepWithError(fe) ?? "confirm"));
        setStep(i);
        setErrors(errorsForStep(fe, WIZARD_STEPS[i].id));
        setNotice(r.message);
        return;
      }
      setNotice(r.message);
    });
  };

  if (publishFailed !== null) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-[20px] font-bold text-heading">下書きは作りましたが、公開側への書き込みに失敗しました</h1>
        <p className="text-[13px] text-body">{publishFailed.message}</p>
        <Link href={`/admin/${publishFailed.slug}`} className="text-[13px] text-heading underline">
          {publishFailed.slug} の編集ページへ
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[20px] font-bold text-heading">事例を新規作成</h1>
      <ol className="flex flex-wrap gap-2 text-[12px]">
        {WIZARD_STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === step ? "step" : undefined}
            className={i === step ? "font-bold text-heading" : "text-muted"}
          >
            {i + 1} {s.label}
          </li>
        ))}
      </ol>

      {current.id === "confirm" ? (
        <Summary values={values} errors={errors} />
      ) : (
        <TenantFormSections values={values} onChange={setValues} errors={errors} section={current.id} slugEditable />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={step === 0 || pending} onClick={() => goTo(step - 1)}>
          戻る
        </button>
        {isConfirm ? (
          <button
            type="button"
            disabled={pending}
            onClick={save}
            className="rounded-md bg-heading px-4 py-2 text-[13px] font-semibold text-card disabled:opacity-50"
          >
            {pending ? "保存中…" : "下書きとして保存"}
          </button>
        ) : (
          <button type="button" className={BTN} onClick={next}>
            次へ
          </button>
        )}
        {notice !== null && (
          <span role="alert" className="text-[13px] text-accent">
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}

function Summary({ values, errors }: { values: TenantFormValues; errors: Record<string, string> }) {
  const rows: [string, string][] = [
    ["サイトタイトル", values.siteTitle],
    ["slug", values.slug],
    ["型", TENANT_PRESETS[values.type].label],
    ["開始日時（JST）", values.monitorStartAt],
    ["終了日（JST）", values.monitorEndDate],
    ["検索語", [...new Set(values.searchKeywords.split("\n").map((k) => k.trim()).filter((k) => k !== ""))].join("、")],
    ["関連性の方式", values.relevanceMode === "score" ? "点数" : "関連あり／なしの2択"],
    ["しきい値", String(values.relevanceThreshold)],
    ["グラフの集計単位（分）", String(values.binMinutes)],
    ["グラフに引く縦線", `${values.keyMoments.length} 件`],
    ["公式情報リンク", `${values.officialSources.length} 件`],
  ];
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
      <h2 className="text-[15px] font-bold text-heading">確認</h2>
      {errors._form !== undefined && (
        <p role="alert" className="text-[13px] text-accent">
          {errors._form}
        </p>
      )}
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="break-words text-heading">{v === "" ? "—" : v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[12px] text-muted">下書きとして保存します。公開は保存後に状態の切り替えで行います。</p>
    </section>
  );
}
