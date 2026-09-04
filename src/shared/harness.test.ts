import { describe, expect, it } from "vitest";
import { parseHarnessInitiator, PIPELINE_INITIATOR_META_KEY } from "./harness.js";

describe("harness initiator metadata", () => {
  it("reads and bounds the broker-authenticated MCP metadata", () => {
    expect(parseHarnessInitiator({
      [PIPELINE_INITIATOR_META_KEY]: { name: `  ${"a".repeat(140)}  `, version: " 1.2.3 " },
    })).toEqual({ name: "a".repeat(128), version: "1.2.3" });
  });

  it.each([undefined, null, {}, { [PIPELINE_INITIATOR_META_KEY]: {} }])(
    "rejects missing or malformed metadata %#",
    (meta) => expect(parseHarnessInitiator(meta)).toBeUndefined(),
  );
});
