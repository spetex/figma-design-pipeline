import { describe, expect, it } from "vitest";
import { FigmaSession } from "./figma-session.js";

const fileAUrl = "https://www.figma.com/design/FileKeyAAAA/File-A";
const fileBUrl = "https://www.figma.com/design/FileKeyBBBB/File-B";

describe("FigmaSession", () => {
  it("reuses a remembered root only for the same file", () => {
    const session = new FigmaSession();
    session.rememberRoot({ fileKey: "FileKeyAAAA", nodeId: "10:20" });

    expect(session.resolveParams({ figmaUrl: fileAUrl }, "FileKeyAAAA").nodeId).toBe("10:20");
    expect(() => session.resolveParams({ figmaUrl: fileBUrl }, "FileKeyAAAA")).toThrow(
      "No node ID provided for Figma file FileKeyBBBB"
    );
  });

  it("does not reuse a coincidentally identical node ID after switching files", () => {
    const session = new FigmaSession();
    session.rememberRoot({ fileKey: "FileKeyAAAA", nodeId: "10:20" });

    expect(() => session.resolveParams({ figmaUrl: fileBUrl }, "FileKeyAAAA")).toThrow(
      /Pass nodeId directly or use a Figma URL with \?node-id=X:Y/
    );

    session.rememberRoot({ fileKey: "FileKeyBBBB", nodeId: "10:20" });
    expect(session.resolveParams({ figmaUrl: fileBUrl }, "FileKeyBBBB").nodeId).toBe("10:20");
  });

  it("clears continuity when a file-only tool switches the active file", () => {
    const session = new FigmaSession();
    session.rememberRoot({ fileKey: "FileKeyAAAA", nodeId: "10:20" });

    session.applyFileKey(fileBUrl, "FileKeyAAAA");

    expect(() => session.resolveParams({}, "FileKeyBBBB")).toThrow(
      "No node ID provided for Figma file FileKeyBBBB"
    );
  });

  it("accepts node IDs supplied by the URL when switching files", () => {
    const session = new FigmaSession();
    session.rememberRoot({ fileKey: "FileKeyAAAA", nodeId: "10:20" });

    expect(
      session.resolveParams({ figmaUrl: `${fileBUrl}?node-id=10-20` }, "FileKeyAAAA")
    ).toMatchObject({ fileKey: "FileKeyBBBB", nodeId: "10:20", fileChanged: true });
  });

  it("keeps an explicit node ID valid when a URL without node-id switches files", () => {
    const session = new FigmaSession();
    session.rememberRoot({ fileKey: "FileKeyAAAA", nodeId: "10:20" });

    expect(
      session.resolveParams({ figmaUrl: fileBUrl, nodeId: "30:40" }, "FileKeyAAAA")
    ).toMatchObject({ fileKey: "FileKeyBBBB", nodeId: "30:40", fileChanged: true });
  });

  it("prefers an explicit node ID over a URL node-id", () => {
    const session = new FigmaSession();

    expect(
      session.resolveParams(
        { figmaUrl: `${fileAUrl}?node-id=10-20`, nodeId: "30:40" },
        "FileKeyAAAA"
      ).nodeId
    ).toBe("30:40");
  });
});
