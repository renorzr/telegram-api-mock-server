import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramApiMockServer } from "../src/telegram-api-mock-server.js";

test("telegram api mock server supports polling and outbound capture", async () => {
  const server = new TelegramApiMockServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const token = "123456:test-token";
  const base = `http://127.0.0.1:${addr!.port}`;

  const injectRes = await fetch(`${base}/_mock/injectUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      update: {
        message: {
          message_id: 1,
          chat: { id: 42, type: "private" },
          from: { id: 1001, is_bot: false, first_name: "Alice" },
          text: "hello",
        },
      },
    }),
  });
  assert.equal(injectRes.status, 200);

  const getUpdatesRes = await fetch(`${base}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: 0, limit: 10 }),
  });
  assert.equal(getUpdatesRes.status, 200);
  const updates = (await getUpdatesRes.json()) as {
    ok: boolean;
    result: Array<{ update_id: number; message?: { text?: string } }>;
  };
  assert.equal(updates.ok, true);
  assert.equal(updates.result.length, 1);
  assert.equal(updates.result[0]?.message?.text, "hello");

  const sendRes = await fetch(`${base}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: 42, text: "reply" }),
  });
  assert.equal(sendRes.status, 200);
  const sendJson = (await sendRes.json()) as { ok: boolean; result?: { message_id?: number } };
  assert.equal(sendJson.ok, true);
  assert.equal(typeof sendJson.result?.message_id, "number");

  const outboundRes = await fetch(`${base}/_mock/outbound?token=${encodeURIComponent(token)}`);
  assert.equal(outboundRes.status, 200);
  const outbound = (await outboundRes.json()) as {
    ok: boolean;
    events: Array<{ method: string; payload: { text?: string } }>;
  };
  assert.equal(outbound.ok, true);
  assert.equal(outbound.events.length, 1);
  assert.equal(outbound.events[0]?.method, "sendMessage");
  assert.equal(outbound.events[0]?.payload.text, "reply");

  await server.stop();
});

test("hosts hijack is applied on start and removed on stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-mock-hosts-"));
  const hostsPath = join(dir, "hosts");
  writeFileSync(hostsPath, "127.0.0.1 localhost\n", "utf8");

  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    interception: {
      enableHostsHijack: true,
      hostsFilePath: hostsPath,
      marker: "tg-mock-test",
    },
  });

  await server.start();
  const startedHosts = readFileSync(hostsPath, "utf8");
  assert.match(startedHosts, /BEGIN tg-mock-test/);
  assert.match(startedHosts, /127\.0\.0\.1 api\.telegram\.org/);

  await server.stop();
  const stoppedHosts = readFileSync(hostsPath, "utf8");
  assert.doesNotMatch(stoppedHosts, /BEGIN tg-mock-test/);
  assert.doesNotMatch(stoppedHosts, /api\.telegram\.org/);
});

test("passthrough mode forwards bot methods to upstream server", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  const upstream = await new Promise<Server>((resolve) => {
    const server = createServer((req, res) => {
      seenPath = req.url ?? "";
      seenMethod = req.method ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { upstream: true } }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const upstreamAddr = upstream.address();
  assert.ok(upstreamAddr && typeof upstreamAddr !== "string");

  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    mode: "passthrough",
    passthrough: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}`,
      bypassHostsForTelegramDomain: false,
    },
  });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const token = "1234:test";
  const response = await fetch(`http://127.0.0.1:${addr!.port}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: 1, text: "hello" }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok: boolean; result?: { upstream?: boolean } };
  assert.equal(payload.ok, true);
  assert.equal(payload.result?.upstream, true);
  assert.equal(seenMethod, "POST");
  assert.equal(seenPath, `/bot${token}/sendMessage`);
  assert.match(seenBody, /"text":"hello"/);

  await server.stop();
  await new Promise<void>((resolve, reject) => {
    upstream.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
});

test("mock server supports myCommands lifecycle", async () => {
  const server = new TelegramApiMockServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const token = "7777:commands";
  const base = `http://127.0.0.1:${addr!.port}`;

  const setRes = await fetch(`${base}/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "start", description: "Start bot" },
        { command: "help", description: "Show help" },
      ],
    }),
  });
  assert.equal(setRes.status, 200);
  const setJson = (await setRes.json()) as { ok: boolean; result?: boolean };
  assert.equal(setJson.ok, true);
  assert.equal(setJson.result, true);

  const getRes = await fetch(`${base}/bot${token}/getMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(getRes.status, 200);
  const getJson = (await getRes.json()) as {
    ok: boolean;
    result: Array<{ command: string; description: string }>;
  };
  assert.equal(getJson.ok, true);
  assert.equal(getJson.result.length, 2);
  assert.equal(getJson.result[0]?.command, "start");

  const delRes = await fetch(`${base}/bot${token}/deleteMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(delRes.status, 200);
  const delJson = (await delRes.json()) as { ok: boolean; result?: boolean };
  assert.equal(delJson.ok, true);
  assert.equal(delJson.result, true);

  const getAfterDelRes = await fetch(`${base}/bot${token}/getMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(getAfterDelRes.status, 200);
  const getAfterDelJson = (await getAfterDelRes.json()) as { ok: boolean; result: Array<unknown> };
  assert.equal(getAfterDelJson.ok, true);
  assert.equal(getAfterDelJson.result.length, 0);

  await server.stop();
});

test("mock server supports additional common outbound methods", async () => {
  const server = new TelegramApiMockServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const token = "9999:common";
  const base = `http://127.0.0.1:${addr!.port}`;

  const methodCalls: Array<{ method: string; payload: Record<string, unknown> }> = [
    { method: "sendChatAction", payload: { chat_id: 42, action: "typing" } },
    { method: "sendPhoto", payload: { chat_id: 42, photo: "file-photo", caption: "img" } },
    { method: "sendDocument", payload: { chat_id: 42, document: "file-doc", caption: "doc" } },
    { method: "deleteMessage", payload: { chat_id: 42, message_id: 10 } },
    { method: "pinChatMessage", payload: { chat_id: 42, message_id: 11 } },
    { method: "unpinChatMessage", payload: { chat_id: 42, message_id: 11 } },
    {
      method: "setMessageReaction",
      payload: {
        chat_id: 42,
        message_id: 12,
        reaction: [{ type: "emoji", emoji: ":thumbs_up:" }],
      },
    },
  ];

  for (const call of methodCalls) {
    const response = await fetch(`${base}/bot${token}/${call.method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call.payload),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { ok: boolean };
    assert.equal(json.ok, true);
  }

  const outboundRes = await fetch(`${base}/_mock/outbound?token=${encodeURIComponent(token)}`);
  assert.equal(outboundRes.status, 200);
  const outbound = (await outboundRes.json()) as {
    ok: boolean;
    events: Array<{ method: string }>;
  };
  assert.equal(outbound.ok, true);
  const methodSet = new Set(outbound.events.map((event) => event.method));
  for (const call of methodCalls) {
    assert.equal(methodSet.has(call.method), true);
  }

  await server.stop();
});

test("mock server exposes request logs", async () => {
  const server = new TelegramApiMockServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const token = "4321:log-token";
  const base = `http://127.0.0.1:${addr!.port}`;

  const injectRes = await fetch(`${base}/_mock/injectUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      update: {
        message: {
          message_id: 1,
          chat: { id: 42, type: "private" },
          text: "abcdefghijk",
        },
      },
    }),
  });
  assert.equal(injectRes.status, 200);

  const getUpdatesRes = await fetch(`${base}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: 0, limit: 10 }),
  });
  assert.equal(getUpdatesRes.status, 200);

  const sendRes = await fetch(`${base}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: 42, text: "1234567890ABC" }),
  });
  assert.equal(sendRes.status, 200);

  const logsRes = await fetch(`${base}/_mock/logs?limit=20`);
  assert.equal(logsRes.status, 200);
  const logsJson = (await logsRes.json()) as {
    ok: boolean;
    logs: Array<{
      path: string;
      method: string;
      status: number;
      tokenHint?: string;
      updatesCount?: number;
      latestUpdateType?: string;
      textPreview?: string;
    }>;
    nextSinceId: number;
  };

  assert.equal(logsJson.ok, true);
  assert.equal(Array.isArray(logsJson.logs), true);
  assert.equal(typeof logsJson.nextSinceId, "number");
  const sendMessageLog = logsJson.logs.find((entry) => entry.path === `/bot${token}/sendMessage`);
  assert.ok(sendMessageLog);
  assert.equal(sendMessageLog.method, "POST");
  assert.equal(sendMessageLog.status, 200);
  assert.equal(typeof sendMessageLog.tokenHint, "string");
  assert.equal(sendMessageLog.textPreview, "1234567890");

  const getUpdatesLog = logsJson.logs.find((entry) => entry.path === `/bot${token}/getUpdates`);
  assert.ok(getUpdatesLog);
  assert.equal(getUpdatesLog.method, "POST");
  assert.equal(getUpdatesLog.status, 200);
  assert.equal(getUpdatesLog.updatesCount, 1);
  assert.equal(getUpdatesLog.latestUpdateType, "message");
  assert.equal(getUpdatesLog.textPreview, "abcdefghij");

  await server.stop();
});

test("telegram api methods accept application/x-www-form-urlencoded", async () => {
  const server = new TelegramApiMockServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const token = "2468:form-token";
  const base = `http://127.0.0.1:${addr!.port}`;

  const injectRes = await fetch(`${base}/_mock/injectUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      update: {
        message: {
          message_id: 2,
          chat: { id: 77, type: "private" },
          text: "from-form-test",
        },
      },
    }),
  });
  assert.equal(injectRes.status, 200);

  const updatesRes = await fetch(`${base}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ offset: "0", limit: "5" }).toString(),
  });
  assert.equal(updatesRes.status, 200);
  const updates = (await updatesRes.json()) as {
    ok: boolean;
    result: Array<{ message?: { text?: string } }>;
  };
  assert.equal(updates.ok, true);
  assert.equal(updates.result[0]?.message?.text, "from-form-test");

  const sendRes = await fetch(`${base}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chat_id: "77", text: "form message" }).toString(),
  });
  assert.equal(sendRes.status, 200);
  const sendJson = (await sendRes.json()) as { ok: boolean; result?: { text?: string; chat?: { id?: number } } };
  assert.equal(sendJson.ok, true);
  assert.equal(sendJson.result?.text, "form message");
  assert.equal(sendJson.result?.chat?.id, 77);

  await server.stop();
});
