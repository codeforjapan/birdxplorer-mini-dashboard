"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
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
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // 復元前の初期値で保存済みの下書きを上書きしないための印
  const restored = useRef(false);

  // SSR との不一致を避けるため、マウント後に読む
  useEffect(() => {
    const d = parseDraft(storageGet());
    if (d !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage はマウント後にしか読めない
      setValues(d.values);
      setStep(d.step);
    }
    restored.current = true;
  }, []);

  useEffect(() => {
    if (!restored.current || createdSlug !== null) return;
    storageSet(JSON.stringify({ values, step }));
  }, [values, step, createdSlug]);

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
        storageClear();
        router.push(`/admin/${r.slug}`);
        return;
      }
      if (r.kind === "publish-failed") {
        // DB には下書きとして入っているので、下書きの再保存は「保存」で公開側に書き直す
        storageClear();
        setCreatedSlug(values.slug);
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

  if (createdSlug !== null) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-[20px] font-bold text-heading">下書きは作りましたが、公開側への書き込みに失敗しました</h1>
        <p className="text-[13px] text-body">
          DB には保存済みです。事例の編集ページで「保存」を押すと、公開側に書き直します。
        </p>
        <Link href={`/admin/${createdSlug}`} className="text-[13px] text-heading underline">
          {createdSlug} の編集ページへ
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
    ["検索語", values.searchKeywords.split("\n").filter((k) => k.trim() !== "").join("、")],
    ["関連性の方式", values.relevanceMode],
    ["しきい値", String(values.relevanceThreshold)],
    ["集計の刻み（分）", String(values.binMinutes)],
    ["主な出来事", `${values.keyMoments.length} 件`],
    ["公式情報", `${values.officialSources.length} 件`],
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
