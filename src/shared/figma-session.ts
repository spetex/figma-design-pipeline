import { parseFigmaUrl } from "./figma-url.js";

export interface RememberedRoot {
  fileKey: string;
  nodeId: string;
}

export interface FileSelection {
  fileKey: string;
  fileName?: string;
  nodeId?: string;
  fileChanged: boolean;
}

export interface ResolvedFigmaParams extends FileSelection {
  nodeId: string;
}

/** Maintains root-node continuity only within the file where the root was read. */
export class FigmaSession {
  private rememberedRoot: RememberedRoot | undefined;

  applyFileKey(figmaUrl: string, currentFileKey: string | undefined): FileSelection {
    const parsed = parseFigmaUrl(figmaUrl);
    const fileChanged = parsed.fileKey !== currentFileKey;

    if (fileChanged) {
      this.rememberedRoot = undefined;
    }

    return { ...parsed, fileChanged };
  }

  resolveParams(
    params: { figmaUrl?: string; nodeId?: string },
    currentFileKey: string | undefined
  ): ResolvedFigmaParams {
    const selection = params.figmaUrl
      ? this.applyFileKey(params.figmaUrl, currentFileKey)
      : undefined;
    const fileKey = selection?.fileKey ?? currentFileKey;
    const rememberedRoot = this.rememberedRoot;
    const nodeId =
      params.nodeId ??
      selection?.nodeId ??
      (rememberedRoot && rememberedRoot.fileKey === fileKey ? rememberedRoot.nodeId : undefined);

    if (!nodeId) {
      const fileDescription = fileKey ? ` for Figma file ${fileKey}` : "";
      throw new Error(
        `No node ID provided${fileDescription}. Pass nodeId directly or use a Figma URL with ?node-id=X:Y.`
      );
    }

    return {
      fileKey: fileKey ?? "",
      fileName: selection?.fileName,
      fileChanged: selection?.fileChanged ?? false,
      nodeId,
    };
  }

  rememberRoot(root: RememberedRoot): void {
    this.rememberedRoot = root;
  }
}
