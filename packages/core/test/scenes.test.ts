import { describe, expect, it } from "vitest";
import { allocateCredits, splitDuration } from "../src/scenes.js";
import { CreativePlanSchema, validatePlanIntegrity } from "../src/plan.js";
import { makePlan } from "./helpers.js";

describe("splitDuration", () => {
  it.each([[4, 5, [4]], [6, 5, [3, 3]], [8, 5, [4, 4]], [12, 5, [4, 4, 4]], [30, 5, [5, 5, 5, 5, 5, 5]], [5, 5, [5]], [7, 5, [4, 3]]])(
    "%is with %is clips", (total, max, expected) => expect(splitDuration(total, max)).toEqual(expected));

  it("always sums to the total and never exceeds the max clip", () => {
    for (let t = 1; t <= 40; t++) for (const max of [3, 4, 5, 10]) {
      const parts = splitDuration(t, max);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(t);
      expect(Math.max(...parts)).toBeLessThanOrEqual(max);
    }
  });
  it("rejects bad input", () => {
    expect(() => splitDuration(0, 5)).toThrow();
    expect(() => splitDuration(5, 0)).toThrow();
  });
});

describe("allocateCredits", () => {
  it("sums exactly to the total", () => {
    for (let total = 1; total <= 60; total++) {
      const parts = allocateCredits(total, [4, 4, 4]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(allocateCredits(13, [5, 5, 5, 5, 5, 5]).reduce((a, b) => a + b, 0)).toBe(13);
  });
});

describe("creative plan", () => {
  it("accepts a valid plan and applies defaults", () => {
    const parsed = CreativePlanSchema.parse(makePlan(8));
    expect(parsed.scenes).toHaveLength(2);
    expect(validatePlanIntegrity(parsed)).toEqual([]);
  });
  it("preserves the user's original text unchanged", () => {
    const p = CreativePlanSchema.parse(makePlan(4, 5, "एक बिल्ली स्केटबोर्ड सीखती है"));
    expect(p.rawInput.description).toBe("एक बिल्ली स्केटबोर्ड सीखती है");
  });
  it("flags unknown character references and bad scene order", () => {
    const p = makePlan(8);
    p.scenes[1]!.characterIds = ["ghost"];
    p.scenes[0]!.index = 5;
    const issues = validatePlanIntegrity(p);
    expect(issues.some((i) => i.includes("unknown character"))).toBe(true);
    expect(issues.some((i) => i.includes("index"))).toBe(true);
  });
  it("rejects a plan with no scenes or unsupported audio language", () => {
    expect(() => CreativePlanSchema.parse({ ...makePlan(4), scenes: [] })).toThrow();
    expect(() => CreativePlanSchema.parse({ ...makePlan(4), audio: { narrationLanguage: "xx", captionLanguage: "en" } })).toThrow();
  });
});
