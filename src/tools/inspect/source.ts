import type { SnapshotCache } from "../../pipeline/snapshot.js";
import type { BridgeServer } from "../../plugin/bridge.js";
import type { FigmaRestClient } from "../../shared/figma-rest.js";
import type { InspectionSource } from "../../shared/plugin-read.js";

export interface InspectionContext {
  rest: FigmaRestClient | null;
  snapshotCache: SnapshotCache;
  bridge: BridgeServer;
}

export function selectInspectionSource(
  ctx: InspectionContext,
  requested: InspectionSource,
  fileKey: string
): "plugin" | "rest" {
  if (requested === "plugin") {
    if (!ctx.bridge.isConnected()) {
      throw new Error("Plugin source requested, but the Figma plugin is not connected.");
    }
    if (!ctx.bridge.canReadFile(fileKey)) {
      const openFile = ctx.bridge.getStatus().fileKey || "unknown";
      throw new Error(`Plugin file mismatch: requested ${fileKey}, open ${openFile}`);
    }
    return "plugin";
  }

  if (requested === "rest") {
    if (!ctx.rest) throw new Error("FIGMA_ACCESS_TOKEN is not set; REST inspection is unavailable.");
    return "rest";
  }

  if (ctx.bridge.canReadFile(fileKey)) return "plugin";
  if (ctx.rest) return "rest";

  if (ctx.bridge.isConnected()) {
    const openFile = ctx.bridge.getStatus().fileKey || "unknown";
    throw new Error(
      `Connected plugin cannot read requested file ${fileKey}; open plugin file is ${openFile}. `
      + "No FIGMA_ACCESS_TOKEN is available for REST fallback."
    );
  }
  throw new Error(
    "No inspection source is available. Connect the Figma plugin for the requested file, "
    + "or set FIGMA_ACCESS_TOKEN for REST API access."
  );
}

export function requireRest(ctx: InspectionContext): FigmaRestClient {
  if (!ctx.rest) {
    throw new Error("FIGMA_ACCESS_TOKEN is not set; REST inspection is unavailable.");
  }
  return ctx.rest;
}
