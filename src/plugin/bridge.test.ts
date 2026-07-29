import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "./bridge.js";

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
});
