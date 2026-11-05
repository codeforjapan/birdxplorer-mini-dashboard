import { describe, expect, it } from "vitest";
import { isAllowedSignIn } from "./sign-in";

const allow = new Set(["a@x.org"]);
const google = { provider: "google" };

describe("isAllowedSignIn", () => {
  it("Google で検証済みかつ許可リストのメールなら許可", () => {
    expect(isAllowedSignIn({ user: { email: "a@x.org" }, account: google, profile: { email_verified: true } }, allow)).toBe(
      true,
    );
  });
  it("メールが未検証なら許可リストにあっても拒否", () => {
    for (const email_verified of [false, undefined, "true"]) {
      expect(isAllowedSignIn({ user: { email: "a@x.org" }, account: google, profile: { email_verified } }, allow)).toBe(
        false,
      );
    }
    expect(isAllowedSignIn({ user: { email: "a@x.org" }, account: google }, allow)).toBe(false);
  });
  it("Google 以外のプロバイダは拒否", () => {
    expect(
      isAllowedSignIn(
        { user: { email: "a@x.org" }, account: { provider: "github" }, profile: { email_verified: true } },
        allow,
      ),
    ).toBe(false);
    expect(isAllowedSignIn({ user: { email: "a@x.org" }, account: null, profile: { email_verified: true } }, allow)).toBe(
      false,
    );
  });
  it("許可リストに無いメールは拒否", () => {
    expect(isAllowedSignIn({ user: { email: "b@x.org" }, account: google, profile: { email_verified: true } }, allow)).toBe(
      false,
    );
  });
});
