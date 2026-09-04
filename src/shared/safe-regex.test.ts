import { describe, expect, it } from "vitest";
import { compileInspectionRegex, MAX_INSPECTION_REGEX_LENGTH } from "./safe-regex.js";

describe("compileInspectionRegex", () => {
  it.each([
    "^Button/(Primary|Secondary)$",
    "card[-_ ]\\d+",
    "^(?:hero|footer)$",
    "[A-Z][a-z]{1,20}",
  ])("accepts practical inspection pattern %s", (pattern) => {
    const compiled = compileInspectionRegex(pattern, "namePattern");
    expect(compiled).toBeDefined();
    expect(compiled!.test("Button/Primary")).toBeTypeOf("boolean");
  });

  it.each([
    "^(a+)\\1$",
    "^(?<word>a+)\\k<word>+$",
    "(?=Button).*",
    "(?<=Button).*",
    "(?>Button)",
  ])("rejects potentially pathological pattern %s", (pattern) => {
    expect(() => compileInspectionRegex(pattern, "namePattern")).toThrow(
      "Unsafe namePattern regex"
    );
  });

  it.each([
    ["^a*a*a*a*a*a*b$", false],
    ["(a+)+$", false],
    ["(a|aa)+$", false],
    ["(?:.*)*$", true],
    ["(a(b+))+$", false],
  ] as const)("executes formerly catastrophic pattern %s with the linear-time engine", (pattern, expected) => {
    const compiled = compileInspectionRegex(pattern, "namePattern")!;
    expect(compiled.test(`${"a".repeat(250_000)}!`)).toBe(expected);
  });

  it("rejects overlong patterns before compilation", () => {
    expect(() => compileInspectionRegex("a".repeat(MAX_INSPECTION_REGEX_LENGTH + 1), "namePattern"))
      .toThrow(`maximum length is ${MAX_INSPECTION_REGEX_LENGTH}`);
  });

  it("matches long normal input case-insensitively", () => {
    const compiled = compileInspectionRegex("^a+z$", "namePattern")!;
    expect(compiled.test(`${"A".repeat(250_000)}Z`)).toBe(true);
  });

  it("still reports invalid syntax distinctly", () => {
    expect(() => compileInspectionRegex("[", "namePattern")).toThrow(
      "Invalid namePattern regex"
    );
  });
});
