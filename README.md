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
- Interception modes:
  - `hosts` mode (legacy): map `api.telegram.org` in hosts file
  - `nftables` mode (recommended): nftables + IP set style redirect for `api.telegram.org`
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
console.log(status.interceptionConfigured, status.hostsHijackActive);
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

## TLS + nftables interception (recommended)

```ts
import { TelegramApiMockServer } from "telegram-api-mock-server";

const server = new TelegramApiMockServer({
  host: "127.0.0.1",
  port: 19090,
  mode: "passthrough",
  admin: {
    token: "change-me",
  },
  tls: {
    certPath: "/path/to/api.telegram.org.crt",
    keyPath: "/path/to/api.telegram.org.key",
  },
});

await server.start();
```

Notes:

- `nftables` mode needs root privileges to apply redirect rules.
- For Node clients, trust your test CA with `NODE_EXTRA_CA_CERTS`.
- Keep interception isolated to test environments.

## OpenClaw environment variables

When OpenClaw is the Telegram Bot API client and traffic is hijacked to this mock server, OpenClaw must trust your test CA.

Required:

- `NODE_EXTRA_CA_CERTS=/path/to/test-ca.crt`

Example:

```bash
NODE_EXTRA_CA_CERTS=/etc/telegram-mock/test-ca.crt openclaw gateway start
```

If OpenClaw runs under systemd, set the same variable in the service unit:

```ini
[Service]
Environment=NODE_EXTRA_CA_CERTS=/etc/telegram-mock/test-ca.crt
```

Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` in normal test setups.

## Global install + daemon style run (Linux)

```bash
npm install -g telegram-api-mock-server

# One command install (includes bootstrap: cert generation + service setup)
telegram-api-mock-server install-service

# Check install/runtime status
telegram-api-mock-server status

# Print test CA path for NODE_EXTRA_CA_CERTS wiring
telegram-api-mock-server print-ca-path

# Optional: uninstall service
telegram-api-mock-server uninstall-service
```

Advanced install options (override defaults):

```bash
telegram-api-mock-server install-service \
  --service-name telegram-api-mock-server \
  --host 127.0.0.1 \
  --port 19090 \
  --redirect-port 19090 \
  --mode passthrough \
  --intercept-mode nftables \
  --refresh-seconds 60 \
  --admin-token change-me \
  --cert-dir /etc/telegram-mock
```

Start in foreground (without systemd):

```bash
telegram-api-mock-server start \
  --host 127.0.0.1 \
  --port 19090 \
  --redirect-port 19090 \
  --mode passthrough \
  --intercept-mode nftables \
  --refresh-seconds 60 \
  --admin-token change-me \
  --tls-cert /etc/telegram-mock/api.telegram.org.crt \
  --tls-key /etc/telegram-mock/api.telegram.org.key
```

When privileged access is required (`bootstrap`, `install-service`, or `start` with interception enabled), the CLI attempts a `sudo` re-exec automatically.

## Development

```bash
npm install
npm run typecheck
npm run test:src
```
