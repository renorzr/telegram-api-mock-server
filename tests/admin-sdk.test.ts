import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramApiMockAdminClient, TelegramApiMockAdminError } from "../src/admin-sdk.js";
import { TelegramApiMockServer } from "../src/telegram-api-mock-server.js";

const ENV_ADMIN_BASE_URL = "TELEGRAM_API_MOCK_ADMIN_BASE_URL";
const ENV_ADMIN_TOKEN = "TELEGRAM_API_MOCK_ADMIN_TOKEN";

test("admin sdk toggles mock mode", async () => {
  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    mode: "mock",
    admin: { token: "admin-secret", host: "127.0.0.1", port: 0 },
  });
  await server.start();
  const adminAddr = server.getAdminAddress();
  assert.ok(adminAddr);

  const client = createTelegramApiMockAdminClient({
    baseUrl: `http://127.0.0.1:${adminAddr!.port}`,
    adminToken: "admin-secret",
  });

  const initial = await client.getStatus();
  assert.equal(initial.mode, "mock");
  assert.equal(typeof initial.interceptionConfigured, "boolean");
  assert.equal(typeof initial.hostsHijackActive, "boolean");

  const switched = await client.disableMock();
  assert.equal(switched.mode, "passthrough");

  const after = await client.getStatus();
  assert.equal(after.mode, "passthrough");

  const health = await client.health();
  assert.equal(health.ok, true);

  const token = "sdk-token";
  const injected = await client.injectUpdate({
    token,
    update: {
      message: {
        message_id: 1,
        chat: { id: 1, type: "private" },
        from: { id: 7 },
        text: "hello",
      },
    },
  });
  assert.equal(injected.ok, true);

  const outbound = await client.listOutbound(token);
  assert.equal(outbound.ok, true);
  assert.equal(Array.isArray(outbound.events), true);

  const reset = await client.reset({ token, updates: true, outbound: true });
  assert.equal(reset.ok, true);

  await server.stop();
});

test("control plane routes are admin-only when admin listener is configured", async () => {
  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    admin: { token: "admin-secret", host: "127.0.0.1", port: 0 },
  });
  await server.start();
  const apiAddr = server.getAddress();
  const adminAddr = server.getAdminAddress();
  assert.ok(apiAddr);
  assert.ok(adminAddr);

  const apiRes = await fetch(`http://127.0.0.1:${apiAddr!.port}/_mock/health`);
  assert.equal(apiRes.status, 404);

  const adminRes = await fetch(`http://127.0.0.1:${adminAddr!.port}/_mock/health`, {
    headers: { "x-admin-token": "admin-secret" },
  });
  assert.equal(adminRes.status, 200);

  await server.stop();
});

test("admin sdk rejects invalid admin token", async () => {
  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    admin: { token: "admin-secret", host: "127.0.0.1", port: 0 },
  });
  await server.start();
  const adminAddr = server.getAdminAddress();
  assert.ok(adminAddr);

  const client = createTelegramApiMockAdminClient({
    baseUrl: `http://127.0.0.1:${adminAddr!.port}`,
    adminToken: "wrong",
  });

  await assert.rejects(
    async () => {
      await client.getStatus();
    },
    (error: unknown) => {
      assert.equal(error instanceof TelegramApiMockAdminError, true);
      if (error instanceof TelegramApiMockAdminError) {
        assert.equal(error.status, 401);
        assert.equal(error.code, "MOCK_AUTH_INVALID");
      }
      return true;
    },
  );

  await server.stop();
});

test("admin sdk supports env defaults for baseUrl and adminToken", async () => {
  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    admin: { token: "admin-secret", host: "127.0.0.1", port: 0 },
  });
  await server.start();
  const adminAddr = server.getAdminAddress();
  assert.ok(adminAddr);

  const prevBaseUrl = process.env[ENV_ADMIN_BASE_URL];
  const prevToken = process.env[ENV_ADMIN_TOKEN];
  process.env[ENV_ADMIN_BASE_URL] = `http://127.0.0.1:${adminAddr!.port}`;
  process.env[ENV_ADMIN_TOKEN] = "admin-secret";

  try {
    const client = createTelegramApiMockAdminClient();
    const status = await client.getStatus();
    assert.equal(status.ok, true);
  } finally {
    if (prevBaseUrl == null) {
      delete process.env[ENV_ADMIN_BASE_URL];
    } else {
      process.env[ENV_ADMIN_BASE_URL] = prevBaseUrl;
    }
    if (prevToken == null) {
      delete process.env[ENV_ADMIN_TOKEN];
    } else {
      process.env[ENV_ADMIN_TOKEN] = prevToken;
    }
    await server.stop();
  }
});
