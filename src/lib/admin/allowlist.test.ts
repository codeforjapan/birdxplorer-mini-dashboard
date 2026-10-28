import { describe, expect, it } from "vitest";
import { isAllowedEmail, parseAllowlist } from "./allowlist";

describe("parseAllowlist", () => {
  it("trim・小文字化・空要素除去", () => {
    expect(parseAllowlist(" A@x.org, ,b@Y.org ")).toEqual(new Set(["a@x.org", "b@y.org"]));
  });
  it("未設定は空集合", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
  });
});

describe("isAllowedEmail", () => {
  const allow = new Set(["a@x.org"]);
  it("大文字小文字を無視して許可", () => {
    expect(isAllowedEmail("A@X.org", allow)).toBe(true);
  });
  it("空集合は拒否", () => {
    expect(isAllowedEmail("a@x.org", new Set())).toBe(false);
  });
  it("email 無しは拒否", () => {
    expect(isAllowedEmail(null, allow)).toBe(false);
    expect(isAllowedEmail(undefined, allow)).toBe(false);
  });
});
