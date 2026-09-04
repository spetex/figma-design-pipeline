import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "./bridge.js";
import { SnapshotCache } from "../pipeline/snapshot.js";
import type { EnrichedNode } from "../shared/types.js";

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
  return port;
}

async function connectPlugin(bridge: BridgeServer, port: number, fileKey = "file-a"): Promise<WebSocket> {
  await bridge.start(port);
  const client = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  client.send(JSON.stringify({
    type: "handshake",
    pluginVersion: "test",
    fileKey,
    pageName: "Page 1",
    documentName: "Bridge test",
  }));
  await vi.waitFor(() => expect(bridge.getStatus().fileKey).toBe(fileKey));
  return client;
}

function readResponse(request: Record<string, unknown>, name: string) {
  return {
    type: "read_response",
    requestId: request.requestId,
    operation: request.operation,
    fileKey: request.fileKey,
    success: true,
    roots: [],
    matches: [{
      id: name,
      name,
      type: "FRAME",
      classification: "container",
      depth: 0,
      childCount: 0,
      children: [],
    }],
    components: [],
    totalScanned: 1,
    returnedCount: 1,
    truncated: false,
    traversalDepth: request.depth,
    resultLimit: request.limit,
    currentPage: { id: "page", name: "Page 1" },
    selection: [],
  };
}

function readParams(name: string) {
  return {
    operation: "find" as const,
    fileKey: "file-a",
    root: "node" as const,
    nodeId: name,
    depth: 2,
    limit: 10,
  };
}

describe("BridgeServer plugin reads", () => {
  afterEach(() => vi.restoreAllMocks());

  it("correlates concurrent out-of-order responses independently from batches", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer();
    const port = await getAvailablePort();
    const client = await connectPlugin(bridge, port);
    const received: Array<Record<string, unknown>> = [];
    client.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    try {
      const first = bridge.read(readParams("first"));
      const second = bridge.read(readParams("second"));
      await vi.waitFor(() => expect(received).toHaveLength(2));
      client.send(JSON.stringify(readResponse(received[1]!, "second")));
      client.send(JSON.stringify(readResponse(received[0]!, "first")));

      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { matches: [{ id: "first" }] },
        { matches: [{ id: "second" }] },
      ]);
      expect(bridge.getStatus()).toMatchObject({ pendingReads: 0, pendingBatches: 0 });
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("rejects file mismatches before sending a read request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer();
    const port = await getAvailablePort();
    const client = await connectPlugin(bridge, port, "open-file");
    const messages = vi.fn();
    client.on("message", messages);
    try {
      await expect(bridge.read({ ...readParams("root"), fileKey: "other-file" }))
        .rejects.toThrow("Plugin file mismatch");
      expect(messages).not.toHaveBeenCalled();
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("cleans up reads on timeout and disconnect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer();
    const port = await getAvailablePort();
    const client = await connectPlugin(bridge, port);
    try {
      await expect(bridge.read(readParams("timeout"), 5)).rejects.toThrow("timed out after 5ms");
      expect(bridge.getStatus().pendingReads).toBe(0);

      const pending = bridge.read(readParams("disconnect"));
      await vi.waitFor(() => expect(bridge.getStatus().pendingReads).toBe(1));
      client.close();
      await expect(pending).rejects.toThrow("Plugin disconnected mid-read");
      expect(bridge.getStatus().pendingReads).toBe(0);
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("reassembles out-of-order large read responses and enforces chunk count limits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer({ maxPayloadBytes: 1024, maxChunkedResultChunks: 16 });
    const port = await getAvailablePort();
    const client = await connectPlugin(bridge, port);
    const requests: Array<Record<string, unknown>> = [];
    client.on("message", (raw) => requests.push(JSON.parse(raw.toString())));
    try {
      const read = bridge.read(readParams("large"));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const response = readResponse(requests[0]!, "x".repeat(2500));
      const serialized = JSON.stringify(response);
      const chunks = Array.from({ length: Math.ceil(serialized.length / 500) }, (_, index) =>
        serialized.slice(index * 500, (index + 1) * 500));
      for (let index = chunks.length - 1; index >= 0; index--) {
        client.send(JSON.stringify({
          type: "read_response_chunk",
          requestId: requests[0]!.requestId,
          chunkIndex: index,
          chunkCount: chunks.length,
          data: chunks[index],
        }));
      }
      await expect(read).resolves.toMatchObject({ matches: [{ id: "x".repeat(2500) }] });

      const rejected = bridge.read(readParams("too-many"));
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      client.send(JSON.stringify({
        type: "read_response_chunk",
        requestId: requests[1]!.requestId,
        chunkIndex: 0,
        chunkCount: 17,
        data: "{}",
      }));
      await expect(rejected).rejects.toThrow("exceeds the 16-chunk limit");
      expect(bridge.isConnected()).toBe(true);
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });
});

describe("BridgeServer WebSocket limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a normal handshake without compression and closes oversized messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer({ maxPayloadBytes: 1024 });
    const port = await getAvailablePort();
    await bridge.start(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}/plugin`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      expect(client.extensions).toBe("");

      client.send(JSON.stringify({
        type: "handshake",
        pluginVersion: "test",
        pageName: "Page 1",
        documentName: "Bridge test",
      }));
      await vi.waitFor(() => {
        expect(bridge.getStatus()).toMatchObject({
          connected: true,
          pluginVersion: "test",
        });
      });

      const closeCode = new Promise<number>((resolve) => {
        client.once("close", resolve);
      });
      client.send(Buffer.alloc(1025, 0x61));

      await expect(closeCode).resolves.toBe(1009);
      await vi.waitFor(() => {
        expect(bridge.isConnected()).toBe(false);
      });
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("invalidates inspection snapshots when the plugin reports a document change", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshotCache = new SnapshotCache();
    snapshotCache.set("file/root", {} as EnrichedNode);
    const bridge = new BridgeServer({
      onDocumentChange: () => snapshotCache.invalidateAll(),
    });
    const port = await getAvailablePort();
    await bridge.start(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}/plugin`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      client.send(JSON.stringify({ type: "document_changed" }));

      await vi.waitFor(() => {
        expect(snapshotCache.get("file/root", Number.POSITIVE_INFINITY)).toBeNull();
      });
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("reassembles large batch results from messages below the payload limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const maxPayloadBytes = 1024;
    const bridge = new BridgeServer({ maxPayloadBytes });
    const port = await getAvailablePort();
    await bridge.start(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}/plugin`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });

      const receivedBatch = new Promise<Record<string, unknown>>((resolve) => {
        client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
      const execution = bridge.execute({
        dryRun: false,
        stopOnError: true,
        rollbackOnError: false,
        requiredFonts: [],
        actions: [{ type: "export_node", nodeId: "1:2" }],
      });
      const batch = await receivedBatch;

      const base64 = "a".repeat(4096);
      const serialized = JSON.stringify({
        type: "batch_result",
        batchId: batch.batchId,
        dryRun: false,
        success: true,
        results: [{
          actionIndex: 0,
          type: "export_node",
          status: "applied",
          nodeId: "1:2",
          after: { format: "PNG", size: 3072, base64 },
        }],
        nodeIdMap: {},
        summary: { total: 1, applied: 1, failed: 0, skipped: 0 },
      });
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(maxPayloadBytes);

      const chunkSize = 256;
      const chunkCount = Math.ceil(serialized.length / chunkSize);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const message = JSON.stringify({
          type: "batch_result_chunk",
          batchId: batch.batchId,
          chunkIndex,
          chunkCount,
          data: serialized.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
        });
        expect(Buffer.byteLength(message)).toBeLessThan(maxPayloadBytes);
        client.send(message);
      }

      const result = await execution;
      expect(result.results[0]?.after?.base64).toBe(base64);
      expect(bridge.isConnected()).toBe(true);
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("rejects a chunked batch result with too many chunks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer({
      maxPayloadBytes: 1024,
      maxChunkedResultChunks: 2,
    });
    const port = await getAvailablePort();
    await bridge.start(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}/plugin`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });

      const receivedBatch = new Promise<Record<string, unknown>>((resolve) => {
        client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
      const execution = bridge.execute({
        dryRun: false,
        stopOnError: true,
        rollbackOnError: false,
        requiredFonts: [],
        actions: [],
      });
      const batch = await receivedBatch;

      client.send(JSON.stringify({
        type: "batch_result_chunk",
        batchId: batch.batchId,
        chunkIndex: 0,
        chunkCount: 3,
        data: "{}",
      }));

      await expect(execution).rejects.toThrow("exceeds the 2-chunk limit");
      expect(bridge.getStatus().pendingBatches).toBe(0);
      expect(bridge.isConnected()).toBe(true);
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });

  it("rejects a chunked batch result when its aggregate byte size is too large", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new BridgeServer({
      maxPayloadBytes: 1024,
      maxChunkedResultBytes: 8,
    });
    const port = await getAvailablePort();
    await bridge.start(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}/plugin`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });

      const receivedBatch = new Promise<Record<string, unknown>>((resolve) => {
        client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
      const execution = bridge.execute({
        dryRun: false,
        stopOnError: true,
        rollbackOnError: false,
        requiredFonts: [],
        actions: [],
      });
      const batch = await receivedBatch;

      client.send(JSON.stringify({
        type: "batch_result_chunk",
        batchId: batch.batchId,
        chunkIndex: 0,
        chunkCount: 2,
        data: "12345678",
      }));
      client.send(JSON.stringify({
        type: "batch_result_chunk",
        batchId: batch.batchId,
        chunkIndex: 1,
        chunkCount: 2,
        data: "9",
      }));

      await expect(execution).rejects.toThrow("exceeds the 8-byte limit");
      expect(bridge.getStatus().pendingBatches).toBe(0);
      expect(bridge.isConnected()).toBe(true);
    } finally {
      client.terminate();
      await bridge.stop();
    }
  });
});
