import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramApiMockAdminClient, TelegramApiMockAdminError } from "../src/admin-sdk.js";
import { TelegramApiMockServer } from "../src/telegram-api-mock-server.js";

test("admin sdk toggles mock mode", async () => {
  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    mode: "mock",
    admin: { token: "admin-secret" },
  });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const client = createTelegramApiMockAdminClient({
    baseUrl: `http://127.0.0.1:${addr!.port}`,
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

  await server.stop();
});

test("admin sdk rejects invalid admin token", async () => {
  const server = new TelegramApiMockServer({
    host: "127.0.0.1",
    port: 0,
    admin: { token: "admin-secret" },
  });
  await server.start();
  const addr = server.getAddress();
  assert.ok(addr);

  const client = createTelegramApiMockAdminClient({
    baseUrl: `http://127.0.0.1:${addr!.port}`,
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
