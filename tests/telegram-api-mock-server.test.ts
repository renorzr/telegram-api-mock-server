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
