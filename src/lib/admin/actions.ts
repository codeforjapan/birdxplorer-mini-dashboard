"use server";

import { revalidatePath } from "next/cache";
import { AdminAuthError, requireAdmin } from "@/lib/admin/session";
import { fieldErrors, toTenantInput, type TenantFormValues } from "@/lib/admin/form";
import { migrate } from "@/lib/db";
import { safeParseTenantInput, type TenantInput } from "@/lib/tenant/input";
import { publishTenant } from "@/lib/tenant/publish";
import { getTenant, listTenantsLenient, saveTenant } from "@/lib/tenant/repo";
import { generateTenantId, isValidSlug } from "@/lib/tenant/slug";
import type { TenantRecord, TenantStatus } from "@/lib/tenant/types";

export type ActionResult =
  | { ok: true; slug: string; updatedAt: number }
  | {
      ok: false;
      kind: "unauthorized" | "invalid" | "exists" | "conflict" | "unreadable" | "publish-failed" | "error";
      message: string;
      fieldErrors?: Record<string, string>;
      /** publish-failed のときだけ。DB は進んでいるので、再保存はこの値で送る */
      updatedAt?: number;
      /** publish-failed のときだけ。作成では画面が採番された slug を知らないので、編集ページへの案内に使う */
      slug?: string;
    };

type Failure = Extract<ActionResult, { ok: false }>;

function fail(kind: Failure["kind"], message: string, errors?: Record<string, string>): Failure {
  return errors === undefined ? { ok: false, kind, message } : { ok: false, kind, message, fieldErrors: errors };
}

const UNAUTHORIZED = "管理画面にログインしていないか、許可されていません";
const UNREADABLE =
  "既存の事例の行が今の検証を通らず読めません。画面からは直せないので scripts/tenant-upsert.ts で上書きしてください（docs/tenant-runbook.md）";

async function authorize(): Promise<Failure | null> {
  try {
    await requireAdmin();
    return null;
  } catch (e) {
    if (e instanceof AdminAuthError) return fail("unauthorized", UNAUTHORIZED);
    throw e;
  }
}

function isUpdatedAt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

// クライアントの値は型どおりとは限らない。変換中の例外も検証エラーとして返す
function parseForm(
  values: unknown,
  base: { status: TenantStatus; searchlightTopicId: string | null },
): { ok: true; input: TenantInput } | { ok: false; failure: Failure } {
  let raw: TenantInput;
  try {
    raw = toTenantInput(values as TenantFormValues, base);
  } catch {
    return { ok: false, failure: fail("invalid", "入力の形が正しくありません") };
  }
  const r = safeParseTenantInput(raw);
  if (!r.ok) return { ok: false, failure: fail("invalid", "入力に誤りがあります", fieldErrors(r.issues)) };
  return { ok: true, input: r.value };
}

async function readExisting(slug: string): Promise<{ ok: true; rec: TenantRecord } | { ok: false; failure: Failure }> {
  let rec: TenantRecord | null;
  try {
    rec = await getTenant(slug);
  } catch (e) {
    console.error(`[admin] 既存の事例が読めません: ${slug}`, e);
    return { ok: false, failure: fail("unreadable", UNREADABLE) };
  }
  if (rec === null) return { ok: false, failure: fail("error", `事例 ${slug} が見つかりません`) };
  return { ok: true, rec };
}

function revalidate(slug: string): void {
  revalidatePath("/admin");
  revalidatePath(`/admin/${slug}`);
}

// publishTenant は index.json を全事例から作り直すので、読めない行が1つでもあると何度保存しても失敗し続ける
async function publishFailure(): Promise<Failure> {
  let unreadable: string[] = [];
  try {
    unreadable = (await listTenantsLenient()).filter((i) => i.record === null).map((i) => i.slug);
  } catch (e) {
    console.error("[admin] 読めない事例の確認に失敗しました", e);
  }
  if (unreadable.length > 0) {
    return fail(
      "publish-failed",
      `DB には保存しましたが、読めない事例（${unreadable.join("、")}）があるため公開側に反映できません。` +
        "1件でも読めない事例があると、他の事例の保存も公開側に反映されません。" +
        "scripts/tenant-upsert.ts でその事例を直してください（docs/tenant-runbook.md）",
    );
  }
  return fail(
    "publish-failed",
    "DB には保存しましたが、公開設定（Blob）の更新に失敗しました。編集画面でもう一度「保存」を押すと公開側に書き直します",
  );
}

async function saveAndPublish(input: TenantInput, expectedUpdatedAt: number | null): Promise<ActionResult> {
  const saved = await saveTenant(input, expectedUpdatedAt);
  if (saved.result === "exists") return fail("exists", `slug ${input.slug} の事例はすでにあります`);
  if (saved.result === "label-taken") {
    const message = `URL「${input.settings.hostLabel}」は他の事例が使っています`;
    return fail("invalid", message, { hostLabel: message });
  }
  if (saved.result === "conflict") {
    return fail("conflict", "開いている間に他の人が保存しました。開き直して最新の内容を確かめてから保存してください");
  }
  // DB は反映済みなので、公開の成否によらず一覧と編集画面を最新にする
  revalidate(input.slug);
  const { record } = saved;
  try {
    await publishTenant(record);
    return { ok: true, slug: record.slug, updatedAt: record.updatedAt };
  } catch (e) {
    console.error(`[admin] 公開に失敗しました: ${input.slug}`, e);
    return { ...(await publishFailure()), updatedAt: record.updatedAt, slug: record.slug };
  }
}

async function run(slug: string, body: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const denied = await authorize();
    if (denied !== null) return denied;
    await migrate();
    return await body();
  } catch (e) {
    console.error(`[admin] 保存に失敗しました: ${slug}`, e);
    return fail("error", "保存に失敗しました。時間をおいてもう一度試してください");
  }
}

export async function createTenantAction(values: TenantFormValues): Promise<ActionResult> {
  // slug は画面から受け取らず、ここで採番する（作成後は変わらない識別子のため）
  const slug = generateTenantId();
  return run(slug, async () => {
    if (typeof values !== "object" || values === null) return fail("invalid", "入力の形が正しくありません");
    const parsed = parseForm({ ...values, slug }, { status: "draft", searchlightTopicId: null });
    if (!parsed.ok) return parsed.failure;
    return saveAndPublish(parsed.input, null);
  });
}

export async function updateTenantAction(
  slug: string,
  values: TenantFormValues,
  expectedUpdatedAt: number,
): Promise<ActionResult> {
  return run(String(slug), async () => {
    if (typeof slug !== "string" || !isValidSlug(slug) || !isUpdatedAt(expectedUpdatedAt)) {
      return fail("invalid", "対象の事例の指定が正しくありません");
    }
    if ((values as Partial<TenantFormValues> | null)?.slug !== slug) {
      return fail("invalid", "slug は変更できません", { slug: "slug は変更できません" });
    }
    const existing = await readExisting(slug);
    if (!existing.ok) return existing.failure;
    const parsed = parseForm(values, {
      status: existing.rec.status,
      searchlightTopicId: existing.rec.settings.searchlightTopicId,
    });
    if (!parsed.ok) return parsed.failure;
    return saveAndPublish(parsed.input, expectedUpdatedAt);
  });
}

const STATUSES: readonly TenantStatus[] = ["draft", "active", "ended"];

export async function changeTenantStatusAction(
  slug: string,
  to: TenantStatus,
  expectedUpdatedAt: number,
): Promise<ActionResult> {
  return run(String(slug), async () => {
    if (typeof slug !== "string" || !isValidSlug(slug) || !isUpdatedAt(expectedUpdatedAt)) {
      return fail("invalid", "対象の事例の指定が正しくありません");
    }
    if (!STATUSES.includes(to)) return fail("invalid", "状態の指定が正しくありません");
    const existing = await readExisting(slug);
    if (!existing.ok) return existing.failure;
    const { rec } = existing;
    // 読み出しの検証は入力より緩いので、そのまま書くと画面からは入れられない値を公開しかねない
    const parsed = safeParseTenantInput({
      slug: rec.slug,
      type: rec.type,
      status: to,
      settings: rec.settings,
      overrides: rec.overrides,
    });
    if (!parsed.ok) {
      return fail("invalid", "保存されている設定に誤りがあります。編集画面で直して保存してから状態を切り替えてください");
    }
    return saveAndPublish(parsed.value, expectedUpdatedAt);
  });
}
