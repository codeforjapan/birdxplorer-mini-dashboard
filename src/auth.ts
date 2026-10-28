import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedEmail } from "@/lib/admin/allowlist";
import { adminEmails } from "@/lib/env";

// NextAuth() は AUTH_* を初回リクエストまで読まない（ビルド時に環境変数が無くても通る）
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login", error: "/admin/login" },
  callbacks: {
    signIn({ user }) {
      return isAllowedEmail(user.email, adminEmails());
    },
  },
});
