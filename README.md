# telegram-api-mock-server

`telegram-api-mock-server` is a standalone Node.js mock server for Telegram Bot API testing.

It is designed for local and CI environments where you want to run integrations without hitting real Telegram infrastructure.

## Features

- Polling-first Telegram API mocks:
  - `getMe`
  - `getUpdates`
  - `sendMessage`
  - `editMessageText`
  - `answerCallbackQuery`
  - `setWebhook`
  - `deleteWebhook`
  - `getWebhookInfo`
- Test control endpoints:
  - `POST /_mock/injectUpdate`
  - `GET /_mock/outbound?token=...`
  - `POST /_mock/reset`
  - `GET /_mock/health`
- Optional TLS mode.
- Optional hosts hijack lifecycle:
  - apply on `start()`
  - rollback on `stop()` and process exit
- Runtime mode switching:
  - `mock`: return mocked Telegram API behavior
  - `passthrough`: forward traffic to real `https://api.telegram.org`
- Admin SDK for mode toggling from test programs.

## Install

```bash
npm install telegram-api-mock-server
```

## Quick start

```ts
import { TelegramApiMockServer } from "telegram-api-mock-server";

const server = new TelegramApiMockServer({ host: "127.0.0.1", port: 19090 });
await server.start();

console.log(server.getAddress());

const token = "123456:test-token";

// Inject one inbound update into getUpdates queue
const injected = server.injectUpdate({
  token,
  update: {
    message: {
      message_id: 1,
      chat: { id: 42, type: "private" },
      from: { id: 1001, is_bot: false, first_name: "Alice" },
      text: "hello",
    },
  },
});

console.log(injected.update_id); // assigned if missing

// Later, after your app calls Telegram APIs against this server:
const outboundCalls = server.listOutbound(token);
console.log(outboundCalls.map((call) => call.method));

// Cleanup queues for this token between test cases
server.reset({ token, updates: true, outbound: true });
```

## Runtime mock switch (Node.js SDK)

```ts
import { createTelegramApiMockAdminClient } from "telegram-api-mock-server";

const admin = createTelegramApiMockAdminClient({
  baseUrl: "http://127.0.0.1:19090",
  adminToken: "change-me",
});

await admin.enableMock(); // mode => mock
await admin.disableMock(); // mode => passthrough (real Telegram API)

const status = await admin.getStatus();
console.log(status.mode);
```

Admin endpoints used by SDK:

- `GET /_admin/status`
- `POST /_admin/mode` with `{ "mode": "mock" | "passthrough" }`

Set `admin.token` on server startup to protect these endpoints.

## Inject and assert

```bash
# Inject inbound update for token
curl -sS -X POST "http://127.0.0.1:19090/_mock/injectUpdate" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "123456:test-token",
    "update": {
      "message": {
        "message_id": 1,
        "chat": { "id": 42, "type": "private" },
        "from": { "id": 1001, "is_bot": false, "first_name": "Alice" },
        "text": "hello"
      }
    }
  }'

# Read captured outbound API calls
curl -sS "http://127.0.0.1:19090/_mock/outbound?token=123456:test-token"
```

## TLS + automatic hosts hijack

```ts
import { TelegramApiMockServer } from "telegram-api-mock-server";

const server = new TelegramApiMockServer({
  host: "127.0.0.1",
  port: 443,
  mode: "passthrough",
  admin: {
    token: "change-me",
  },
  tls: {
    certPath: "/path/to/api.telegram.org.crt",
    keyPath: "/path/to/api.telegram.org.key",
  },
  interception: {
    enableHostsHijack: true,
    hostsFilePath: "/etc/hosts",
    domain: "api.telegram.org",
    ip: "127.0.0.1",
  },
});

await server.start();
```

Notes:

- `enableHostsHijack` needs write permission to hosts file (usually `sudo`).
- For Node clients, trust your test CA with `NODE_EXTRA_CA_CERTS`.
- Keep interception isolated to test environments.

## Global install + daemon style run (Linux)

```bash
npm install -g telegram-api-mock-server

# Start in foreground (common for CI/service wrappers)
telegram-api-mock-server start \
  --host 127.0.0.1 \
  --port 443 \
  --mode passthrough \
  --admin-token change-me \
  --enable-hosts-hijack \
  --tls-cert /etc/telegram-mock/api.telegram.org.crt \
  --tls-key /etc/telegram-mock/api.telegram.org.key
```

When `--enable-hosts-hijack` is set and `/etc/hosts` is not writable, the CLI attempts a `sudo` re-exec automatically.

## Development

```bash
npm install
npm run typecheck
npm run test:src
```
