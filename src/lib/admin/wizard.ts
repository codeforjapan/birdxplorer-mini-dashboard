import { newFormValues, toTenantInput, fieldErrors, type TenantFormValues } from "./form";
import { safeParseTenantInput } from "../tenant/input";
import { TENANT_PRESETS } from "../tenant/presets";
import type { TenantTypeId } from "../tenant/types";

// クライアントからも読み込むので、Node 専用の import は置かない

export type WizardStep = "basic" | "period" | "taxonomy" | "display" | "confirm";

export const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: "basic", label: "基本" },
  { id: "period", label: "期間と検索語" },
  { id: "taxonomy", label: "分類の例文" },
  { id: "display", label: "表示まわり" },
  { id: "confirm", label: "確認" },
];

export const STORAGE_KEY = "admin:new-tenant";

const BASIC_KEYS = new Set(["slug", "type", "siteTitle"]);
const PERIOD_KEYS = new Set(["monitorStartAt", "monitorEndDate", "searchKeywords"]);
const TAXONOMY_KEYS = new Set(["relevanceMode", "relevanceThreshold", "binMinutes"]);

/** TenantFormSections の各セクションが出す欄に合わせる。残りの欄は表示まわり（"_form" は確認で出す） */
export function stepOfField(key: string): WizardStep {
  if (key === "_form") return "confirm";
  if (BASIC_KEYS.has(key)) return "basic";
  if (PERIOD_KEYS.has(key)) return "period";
  if (TAXONOMY_KEYS.has(key) || key.startsWith("taxonomy.")) return "taxonomy";
  return "display";
}

/** 全欄の検証結果。toTenantInput が壊れた値で投げたら "_form" に載せる */
export function validateForm(values: TenantFormValues): Record<string, string> {
  try {
    const r = safeParseTenantInput(toTenantInput(values, { status: "draft", searchlightTopicId: null }));
    return r.ok ? {} : fieldErrors(r.issues);
  } catch {
    return { _form: "入力の形が正しくありません" };
  }
}

export function errorsForStep(errors: Record<string, string>, step: WizardStep): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => stepOfField(k) === step));
}

export function firstStepWithError(errors: Record<string, string>): WizardStep | null {
  const steps = new Set(Object.keys(errors).map(stepOfField));
  return WIZARD_STEPS.find((s) => steps.has(s.id))?.id ?? null;
}

/** localStorage の中身は信用できないので、既定値に重ねて形を確かめる */
export function parseDraft(raw: string | null): { values: TenantFormValues; step: number } | null {
  if (raw === null) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const { values, step } = j as { values?: unknown; step?: unknown };
  if (typeof values !== "object" || values === null) return null;
  const v = values as Record<string, unknown>;
  if (typeof v.type !== "string" || !Object.hasOwn(TENANT_PRESETS, v.type)) return null;
  const base = newFormValues(v.type as TenantTypeId);
  const merged: Record<string, unknown> = { ...base };
  for (const [k, def] of Object.entries(base)) {
    const x = v[k];
    if (typeof def === "string" && typeof x === "string") merged[k] = x;
    else if (typeof def === "number" && typeof x === "number" && Number.isFinite(x)) merged[k] = x;
  }
  merged.relevanceMode = v.relevanceMode === "score" || v.relevanceMode === "binary" ? v.relevanceMode : base.relevanceMode;
  const tax: Record<string, unknown> = { ...base.taxonomy };
  const rawTax = typeof v.taxonomy === "object" && v.taxonomy !== null ? (v.taxonomy as Record<string, unknown>) : {};
  for (const k of Object.keys(base.taxonomy)) {
    const x = rawTax[k];
    if (typeof x === "string" || x === null) tax[k] = x;
  }
  merged.taxonomy = tax;
  const objs = (x: unknown): Record<string, unknown>[] =>
    Array.isArray(x) ? x.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null) : [];
  merged.keyMoments = objs(v.keyMoments)
    .filter((e) => typeof e.at === "string" && typeof e.markerLabel === "string")
    .map((e) => ({ at: e.at, markerLabel: e.markerLabel }));
  merged.officialSources = objs(v.officialSources)
    .filter((e) => typeof e.label === "string" && typeof e.url === "string")
    .map((e) => ({ label: e.label, url: e.url }));
  const s = typeof step === "number" && Number.isInteger(step) ? Math.min(Math.max(step, 0), WIZARD_STEPS.length - 1) : 0;
  return { values: merged as TenantFormValues, step: s };
}
