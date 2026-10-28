import { describe, expect, it } from "vitest";
import { newFormValues } from "./form";
import { errorsForStep, firstStepWithError, parseDraft, stepOfField, validateForm } from "./wizard";

describe("stepOfField", () => {
  it("欄をステップに振り分ける", () => {
    expect(stepOfField("slug")).toBe("basic");
    expect(stepOfField("monitorEndDate")).toBe("period");
    expect(stepOfField("taxonomy.relevantExamples")).toBe("taxonomy");
    expect(stepOfField("binMinutes")).toBe("taxonomy");
    expect(stepOfField("keyMoments.0.at")).toBe("display");
    expect(stepOfField("issuesUrl")).toBe("display");
    expect(stepOfField("_form")).toBe("confirm");
  });
});

describe("validateForm / errorsForStep", () => {
  it("空の新規は基本と期間のエラーを返し、他のステップには混ぜない", () => {
    const errors = validateForm(newFormValues("disaster"));
    expect(Object.keys(errorsForStep(errors, "basic")).length).toBeGreaterThan(0);
    expect(errorsForStep(errors, "basic").monitorStartAt).toBeUndefined();
    expect(firstStepWithError(errors)).toBe("basic");
  });

  it("壊れた値で投げても _form に落とす", () => {
    const v = { ...newFormValues("disaster"), keyMoments: null } as never;
    expect(validateForm(v)._form).toBeDefined();
  });
});

describe("parseDraft", () => {
  it("壊れた JSON・型不明は null", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("{")).toBeNull();
    expect(parseDraft(JSON.stringify({ values: { type: "zzz" } }))).toBeNull();
  });

  it("欠けた欄は既定で補い、step は範囲内に収める", () => {
    const d = parseDraft(JSON.stringify({ step: 99, values: { type: "election", slug: "a", keyMoments: 3 } }));
    expect(d?.step).toBe(4);
    expect(d?.values.slug).toBe("a");
    expect(d?.values.keyMoments).toEqual([]);
    expect(d?.values.taxonomy).toEqual(newFormValues("election").taxonomy);
  });
});
