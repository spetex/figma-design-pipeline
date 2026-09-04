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
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: "",
        innerHTML: "",
        className: "",
        title: "",
        style: { color: "" },
        addEventListener() {},
        setPointerCapture() {},
      });
    }
    return elements.get(id)!;
  };
  const context = vm.createContext({
    WebSocket: FakeWebSocket,
    window: { innerHeight: 560 },
    parent: { postMessage() {} },
    document: { getElementById: element },
    console: { error() {} },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(script, context);
  return {
    socket: sockets[0]!,
    element(id: string) { return elements.get(id)!; },
    send(data: Record<string, unknown>) {
      Object.assign(context, { testPayload: data });
      vm.runInContext("sendToBridge(testPayload)", context);
    },
    pluginMessage(data: Record<string, unknown>) {
      Object.assign(context, { testPluginMessage: data });
      vm.runInContext("window.onmessage({ data: { pluginMessage: testPluginMessage } })", context);
    },
    bridgeInfo(data: Record<string, unknown>) {
      Object.assign(context, { testBridgeInfo: data });
      vm.runInContext("applyBridgeInfo(testBridgeInfo)", context);
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

describe("plugin activity dashboard", () => {
  it("starts with native connection details collapsed", () => {
    const html = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
    expect(html).toContain('<details class="card connection-card">');
    expect(html).not.toContain('<details class="card connection-card" open>');
    expect(html).toContain('<h1>Design Pipeline</h1>');
    expect(html).toContain('id="resize-handle"');
  });

  it("renders harness metadata and normalizes known MCP client names", () => {
    const transport = loadUiTransport();
    transport.bridgeInfo({
      harness: { name: "codex-mcp-client", version: "1.2.3" },
      serverVersion: "0.10.0",
      port: 4012,
    });

    expect(transport.element("harness").textContent).toBe("Codex 1.2.3");
    expect(transport.element("harness").title).toBe("codex-mcp-client");
  });

  it("groups multiple connected sessions by harness and version", () => {
    const transport = loadUiTransport();
    transport.bridgeInfo({
      harness: { name: "figma-pipeline-broker", version: "1.1.0" },
      harnesses: [
        { name: "codex-mcp-client", version: "0.151.0" },
        { name: "codex-mcp-client", version: "0.151.0" },
        { name: "claude-code", version: "2.0.0" },
      ],
      serverVersion: "0.10.0",
      port: 4010,
    });

    expect(transport.element("harness").textContent).toBe("Codex 0.151.0 ×2, Claude Code 2.0.0");
  });

  it("keeps the ten most recently active actions and renders failures safely", () => {
    const transport = loadUiTransport();
    for (let index = 0; index < 11; index++) {
      transport.pluginMessage({
        type: "activity_event",
        event: "queued",
        id: `batch:${index}`,
        batchId: "batch",
        actionIndex: index,
        actionType: "create_frame",
        summary: `Frame ${index}`,
        initiator: { name: "codex-mcp-client", version: "0.151.0" },
        at: "2026-09-04T12:00:00.000Z",
      });
    }
    transport.pluginMessage({
      type: "activity_event",
      event: "completed",
      id: "batch:10",
      batchId: "batch",
      actionIndex: 10,
      actionType: "create_frame",
      outcome: "failed",
      error: '<script>alert("no")</script>',
      at: "2026-09-04T12:00:01.000Z",
      durationMs: 25,
    });

    const html = String(transport.element("activity-list").innerHTML);
    expect((html.match(/class="activity"/g) || [])).toHaveLength(10);
    expect(html).toContain("Failed");
    expect(html).toContain("25 ms");
    expect(html).toContain("via Codex 0.151.0");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Frame 0");
  });
});
