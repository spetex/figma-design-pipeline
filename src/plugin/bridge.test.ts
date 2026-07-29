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
});
