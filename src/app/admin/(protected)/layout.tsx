import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { requireAdmin } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  let email: string | null = null;
  try {
    email = (await requireAdmin()).email;
  } catch {
    // redirect() は例外で動くので try の外で呼ぶ
  }
  if (email === null) redirect("/admin/login");

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between gap-3 border-b border-line pb-3">
        <Link href="/admin" className="text-[15px] font-bold text-heading">
          管理画面
        </Link>
        <div className="flex items-center gap-3 text-[12px] text-muted">
          <span>{email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/admin/login" });
            }}
          >
            <button type="submit" className="underline hover:text-heading">
              ログアウト
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
