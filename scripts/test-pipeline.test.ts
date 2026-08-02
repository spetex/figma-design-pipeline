import { describe, expect, it } from "vitest";

describe("test-pipeline script", () => {
  it("imports its current runtime dependency graph without executing the live pipeline", async () => {
    const pipeline = await import("./test-pipeline.js");

    expect(pipeline.main).toBeTypeOf("function");
  });
});
