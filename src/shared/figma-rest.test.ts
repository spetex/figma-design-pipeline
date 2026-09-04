import { afterEach, describe, expect, it, vi } from "vitest";
import { FigmaRestClient } from "./figma-rest.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FigmaRestClient depth queries", () => {
  it.each([
    ["getFile", () => new FigmaRestClient("token", "file-a").getFile({ depth: 0 })],
    ["getFileNodes", () => new FigmaRestClient("token", "file-a").getFileNodes(["1:2"], { depth: 0 })],
  ])("preserves an explicit depth=0 for %s", async (_label, request) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await request();

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("depth")).toBe("0");
  });

  it("omits depth only when it is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await new FigmaRestClient("token", "file-a").getFile();

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.has("depth")).toBe(false);
  });
});
