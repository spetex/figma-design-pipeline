import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export const DEFAULT_BRIDGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const DEFAULT_BRIDGE_MAX_CHUNKED_RESULT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_BRIDGE_MAX_CHUNKED_RESULT_CHUNKS = 64;

export interface BridgeServerOptions {
  maxPayloadBytes?: number;
  maxChunkedResultBytes?: number;
  maxChunkedResultChunks?: number;
}

export interface BridgeStatus {
  connected: boolean;
  mode: "plugin" | "fallback";
  port: number | null;
  pluginVersion?: string;
  pageName?: string;
  documentName?: string;
  fallbackAvailable: boolean;
  message: string;
  recommendedAction?: string;
  lastHandshakeAt?: string;
  lastPongAt?: string;
  pendingBatches: number;
}

interface PendingBatch {
  resolve: (result: BatchResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ChunkedBatchResult {
  chunkCount: number;
  chunks: Map<number, string>;
  totalBytes: number;
}

export interface BatchResult {
  batchId: string;
  dryRun: boolean;
  success: boolean;
  results: Array<{
    actionIndex: number;
    type: string;
    status: "applied" | "planned" | "failed" | "skipped";
    nodeId?: string;
    newNodeId?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    error?: string;
  }>;
  nodeIdMap: Record<string, string>;
  summary: { total: number; applied: number; failed: number; skipped: number };
  error?: string;
}

export interface Batch {
  type: "batch";
  batchId: string;
  dryRun: boolean;
  stopOnError: boolean;
  rollbackOnError: boolean;
  requiredFonts: Array<{ family: string; style?: string }>;
  actions: Array<Record<string, unknown>>;
}

export class BridgeServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private plugin: WebSocket | null = null;
  private boundPort: number | null = null;
  private pending = new Map<string, PendingBatch>();
  private chunkedResults = new Map<string, ChunkedBatchResult>();
  private pluginInfo: { pluginVersion?: string; pageName?: string; documentName?: string } = {};
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHandshakeAt: string | null = null;
  private lastPongAt: string | null = null;
  private readonly maxPayloadBytes: number;
  private readonly maxChunkedResultBytes: number;
  private readonly maxChunkedResultChunks: number;

  constructor({
    maxPayloadBytes = DEFAULT_BRIDGE_MAX_PAYLOAD_BYTES,
    maxChunkedResultBytes = DEFAULT_BRIDGE_MAX_CHUNKED_RESULT_BYTES,
    maxChunkedResultChunks = DEFAULT_BRIDGE_MAX_CHUNKED_RESULT_CHUNKS,
  }: BridgeServerOptions = {}) {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
      throw new Error("maxPayloadBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(maxChunkedResultBytes) || maxChunkedResultBytes <= 0) {
      throw new Error("maxChunkedResultBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(maxChunkedResultChunks) || maxChunkedResultChunks <= 0) {
      throw new Error("maxChunkedResultChunks must be a positive integer");
    }
    this.maxPayloadBytes = maxPayloadBytes;
    this.maxChunkedResultBytes = maxChunkedResultBytes;
    this.maxChunkedResultChunks = maxChunkedResultChunks;
  }

  async start(preferredPort = 4010): Promise<number> {
    for (let port = preferredPort; port < preferredPort + 5; port++) {
      try {
        return await this.listen(port);
      } catch {
        continue;
      }
    }
    throw new Error(`Could not bind bridge server on ports ${preferredPort}-${preferredPort + 4}`);
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((_, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, connected: this.isConnected(), port }));
      });

      server.on("error", reject);

      const wss = new WebSocketServer({
        server,
        path: "/plugin",
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false,
      });
      wss.on("error", reject);

      wss.on("connection", (ws) => {
        // Replace existing connection
        if (this.plugin) {
          try { this.plugin.close(); } catch { /* ignore */ }
        }
        this.plugin = ws;
        console.error(`[bridge] Plugin connected on port ${port}`);
        this.startPingLoop();

        ws.on("message", (raw) => {
          try {
            const data = JSON.parse(raw.toString());
            this.handleMessage(data);
          } catch (err) {
            console.error("[bridge] Bad message:", err);
          }
        });

        ws.on("error", (err) => {
          console.error(`[bridge] WebSocket error: ${err.message}`);
        });

        ws.on("close", () => {
          if (this.plugin === ws) {
            this.plugin = null;
            this.pluginInfo = {};
            this.lastHandshakeAt = null;
            this.lastPongAt = null;
            this.stopPingLoop();
            // Snapshot and clear before rejecting to avoid double-rejection race with timeouts
            const inFlight = new Map(this.pending);
            this.pending.clear();
            this.chunkedResults.clear();
            for (const [, p] of inFlight) {
              clearTimeout(p.timer);
              p.reject(new Error("Plugin disconnected mid-batch"));
            }
            console.error("[bridge] Plugin disconnected");
          }
        });
      });

      server.listen(port, "127.0.0.1", () => {
        this.httpServer = server;
        this.wss = wss;
        this.boundPort = port;
        resolve(port);
      });
    });
  }

  private handleMessage(data: Record<string, unknown>): void {
    if (data.type === "handshake") {
      this.pluginInfo = {
        pluginVersion: data.pluginVersion as string,
        pageName: data.pageName as string,
        documentName: data.documentName as string,
      };
      this.lastHandshakeAt = new Date().toISOString();
      console.error(`[bridge] Handshake: ${this.pluginInfo.documentName} / ${this.pluginInfo.pageName} (plugin v${this.pluginInfo.pluginVersion})`);
      return;
    }

    if (data.type === "batch_result") {
      const batchId = data.batchId as string;
      const pending = this.pending.get(batchId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(batchId);
        this.chunkedResults.delete(batchId);
        pending.resolve(data as unknown as BatchResult);
      }
      return;
    }

    if (data.type === "batch_result_chunk") {
      this.handleBatchResultChunk(data);
      return;
    }

    if (data.type === "pong") {
      this.pluginInfo.pageName = data.pageName as string;
      this.pluginInfo.documentName = (data.documentName as string) || this.pluginInfo.documentName;
      this.lastPongAt = new Date().toISOString();
      return;
    }
  }

  private handleBatchResultChunk(data: Record<string, unknown>): void {
    const batchId = data.batchId;
    const chunkIndex = data.chunkIndex;
    const chunkCount = data.chunkCount;
    const chunk = data.data;

    if (
      typeof batchId !== "string"
      || !Number.isSafeInteger(chunkIndex)
      || (chunkIndex as number) < 0
      || !Number.isSafeInteger(chunkCount)
      || (chunkCount as number) <= 0
      || (chunkIndex as number) >= (chunkCount as number)
      || typeof chunk !== "string"
    ) {
      if (typeof batchId === "string") {
        this.rejectPending(batchId, "Plugin sent malformed batch result chunk metadata");
      }
      return;
    }

    if (!this.pending.has(batchId)) {
      return;
    }

    const expectedChunkCount = chunkCount as number;
    if (expectedChunkCount > this.maxChunkedResultChunks) {
      this.rejectPending(
        batchId,
        `Plugin batch result exceeds the ${this.maxChunkedResultChunks}-chunk limit`,
      );
      return;
    }

    let assembly = this.chunkedResults.get(batchId);
    if (!assembly) {
      assembly = { chunkCount: expectedChunkCount, chunks: new Map(), totalBytes: 0 };
      this.chunkedResults.set(batchId, assembly);
    } else if (assembly.chunkCount !== chunkCount) {
      this.rejectPending(batchId, "Plugin sent inconsistent batch result chunk metadata");
      return;
    }

    const index = chunkIndex as number;
    const existing = assembly.chunks.get(index);
    if (existing !== undefined && existing !== chunk) {
      this.rejectPending(batchId, `Plugin sent conflicting data for batch result chunk ${index}`);
      return;
    }
    if (existing === undefined) {
      const chunkBytes = Buffer.byteLength(chunk);
      if (chunkBytes > this.maxChunkedResultBytes - assembly.totalBytes) {
        this.rejectPending(
          batchId,
          `Plugin batch result exceeds the ${this.maxChunkedResultBytes}-byte limit`,
        );
        return;
      }
      assembly.chunks.set(index, chunk);
      assembly.totalBytes += chunkBytes;
    }

    if (assembly.chunks.size !== assembly.chunkCount) {
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < assembly.chunkCount; i++) {
      const part = assembly.chunks.get(i);
      if (part === undefined) {
        return;
      }
      chunks.push(part);
    }
    this.chunkedResults.delete(batchId);

    try {
      const result = JSON.parse(chunks.join("")) as Record<string, unknown>;
      if (result.type !== "batch_result" || result.batchId !== batchId) {
        this.rejectPending(batchId, "Plugin sent a mismatched chunked batch result");
        return;
      }
      this.handleMessage(result);
    } catch {
      this.rejectPending(batchId, "Plugin sent an invalid chunked batch result");
    }
  }

  private rejectPending(batchId: string, message: string): void {
    const pending = this.pending.get(batchId);
    this.chunkedResults.delete(batchId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(batchId);
    pending.reject(new Error(message));
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.plugin || this.plugin.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        this.plugin.send(JSON.stringify({ type: "ping" }));
      } catch {
        // Ignore send errors; close handler will clear state.
      }
    }, 5000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  async execute(batch: Omit<Batch, "type" | "batchId">, timeoutMs = 30000): Promise<BatchResult> {
    if (!this.plugin || this.plugin.readyState !== WebSocket.OPEN) {
      throw new Error("Plugin not connected. Open the SPFR Design Pipeline plugin in Figma.");
    }

    const batchId = randomUUID();
    const fullBatch: Batch = { type: "batch", batchId, ...batch };

    return new Promise<BatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(batchId);
        this.chunkedResults.delete(batchId);
        reject(new Error(`Batch ${batchId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(batchId, { resolve, reject, timer });
      this.plugin!.send(JSON.stringify(fullBatch));
    });
  }

  isConnected(): boolean {
    return this.plugin !== null && this.plugin.readyState === WebSocket.OPEN;
  }

  getStatus(): BridgeStatus {
    const connected = this.isConnected();
    const message = connected
      ? `Plugin connected on port ${this.boundPort}${this.pluginInfo.documentName ? ` for ${this.pluginInfo.documentName}` : ""}${this.pluginInfo.pageName ? ` / ${this.pluginInfo.pageName}` : ""}.`
      : "Plugin bridge is not connected. figma_execute will return fallback use_figma JavaScript.";

    return {
      connected,
      mode: connected ? "plugin" : "fallback",
      port: this.boundPort,
      fallbackAvailable: true,
      message,
      recommendedAction: connected
        ? "Use figma_execute for batched writes."
        : "Open the SPFR Design Pipeline plugin in Figma Desktop to enable fast batched writes.",
      ...this.pluginInfo,
      lastHandshakeAt: this.lastHandshakeAt ?? undefined,
      lastPongAt: this.lastPongAt ?? undefined,
      pendingBatches: this.pending.size,
    };
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge shutting down"));
    }
    this.pending.clear();
    this.chunkedResults.clear();
    this.stopPingLoop();
    if (this.plugin) { try { this.plugin.close(); } catch { /* ignore */ } }
    if (this.wss) this.wss.close();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
  }
}
