import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type SentSocket = { readyState: number; sent: string[]; send(value: string): void };

function loadUiTransport() {
  const html = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("plugin UI script not found");

  const sockets: SentSocket[] = [];
  class FakeWebSocket implements SentSocket {
    readyState = 1;
    sent: string[] = [];
    constructor(_url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() {}
  }
  const element = () => ({ textContent: "", style: { color: "" } });
  const context = vm.createContext({
    WebSocket: FakeWebSocket,
    window: {},
    parent: { postMessage() {} },
    document: { getElementById: element },
    console: { error() {} },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(script, context);
  return {
    socket: sockets[0]!,
    send(data: Record<string, unknown>) {
      Object.assign(context, { testPayload: data });
      vm.runInContext("sendToBridge(testPayload)", context);
    },
  };
}

function readResponse(payload: string) {
  return JSON.parse(payload) as Record<string, unknown>;
}

describe("plugin UI result transport bounds", () => {
  it("chunks a normal Unicode read response without corrupting it", () => {
    const transport = loadUiTransport();
    const response = {
      type: "read_response",
      requestId: "read-normal",
      operation: "tree",
      fileKey: "file-a",
      success: true,
      value: "😀".repeat(600_000),
    };

    transport.send(response);

    expect(transport.socket.sent).toHaveLength(2);
    const chunks = transport.socket.sent.map(readResponse);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    expect(chunks.every((chunk) => chunk.chunkCount === 2)).toBe(true);
    expect(chunks.map((chunk) => chunk.data).join("")).toBe(JSON.stringify(response));
  });

  it("rejects excessive chunk counts before emitting any chunks", () => {
    const transport = loadUiTransport();
    transport.send({
      type: "read_response",
      requestId: "read-chunks",
      operation: "find",
      fileKey: "file-a",
      success: true,
      value: "a".repeat(16 * 1024 * 1024 + 1),
    });

    expect(transport.socket.sent).toHaveLength(1);
    expect(readResponse(transport.socket.sent[0]!)).toMatchObject({
      type: "read_response",
      requestId: "read-chunks",
      operation: "find",
      fileKey: "file-a",
      success: false,
      error: expect.stringContaining("16-chunk sender limit"),
    });
  });

  it("rejects excessive aggregate encoded bytes before emitting any chunks", () => {
    const transport = loadUiTransport();
    transport.send({
      type: "read_response",
      requestId: "read-bytes",
      operation: "components",
      fileKey: "file-a",
      success: true,
      value: "ࠀ".repeat(5_600_000),
    });

    expect(transport.socket.sent).toHaveLength(1);
    expect(readResponse(transport.socket.sent[0]!)).toMatchObject({
      type: "read_response",
      requestId: "read-bytes",
      operation: "components",
      fileKey: "file-a",
      success: false,
      error: expect.stringContaining("16777216-byte sender limit"),
    });
  });
});
