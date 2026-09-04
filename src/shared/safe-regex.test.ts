import { describe, expect, it } from "vitest";
import { compileInspectionRegex } from "./safe-regex.js";

describe("compileInspectionRegex", () => {
  it.each([
    "^Button/(Primary|Secondary)$",
    "card[-_ ]\\d+",
    "^(?:hero|footer)$",
    "[A-Z][a-z]{1,20}",
  ])("accepts practical inspection pattern %s", (pattern) => {
    expect(compileInspectionRegex(pattern, "namePattern")).toBeInstanceOf(RegExp);
  });

  it.each([
    "(a+)+$",
    "(a|aa)+$",
    "(?:.*)*$",
    "(a(b+))+$",
    "^(a+)\\1$",
    "(?=Button).*",
  ])("rejects potentially pathological pattern %s", (pattern) => {
    expect(() => compileInspectionRegex(pattern, "namePattern")).toThrow(
      "Unsafe namePattern regex"
    );
  });

  it("still reports invalid syntax distinctly", () => {
    expect(() => compileInspectionRegex("[", "namePattern")).toThrow(
      "Invalid namePattern regex"
    );
  });
});
