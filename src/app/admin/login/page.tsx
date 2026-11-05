import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-sm px-4 py-16">
      <div className="rounded-lg border border-line bg-card p-6">
        <h1 className="text-[20px] font-bold text-heading">管理画面</h1>
        {error !== undefined && (
          <p role="alert" className="mt-3 text-[13px] text-strong">
            {error === "AccessDenied"
              ? "このアカウントは許可されていません"
              : "ログインに失敗しました。もう一度試してください"}
          </p>
        )}
        <form
          className="mt-5"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/admin" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md border border-line bg-card px-4 py-2 text-[14px] font-semibold text-heading hover:bg-block"
          >
            Google でログイン
          </button>
        </form>
      </div>
    </main>
  );
}
