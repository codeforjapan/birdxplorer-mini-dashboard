import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedSignIn } from "@/lib/admin/sign-in";
import { adminEmails } from "@/lib/env";

// AUTH_* はモジュール読み込み時に読まれる。値が無いことのエラーだけが初回リクエストまで遅れるので、ビルド時に無くても通る
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login", error: "/admin/login" },
  callbacks: {
    signIn(params) {
      return isAllowedSignIn(params, adminEmails());
    },
  },
});
