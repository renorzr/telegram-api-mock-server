import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";

type TelegramApiMockServerOptions = {
  host?: string;
  port?: number;
  tls?: {
    certPath: string;
    keyPath: string;
  };
  interception?: {
    enableHostsHijack?: boolean;
    hostsFilePath?: string;
    domain?: string;
    ip?: string;
    marker?: string;
  };
};

type TelegramUpdate = Record<string, unknown> & {
  update_id?: number;
};

export type TelegramApiMockOutboundCall = {
  token: string;
  method: string;
  payload: Record<string, unknown>;
  ts: string;
};

type TokenState = {
  updates: TelegramUpdate[];
  outbound: TelegramApiMockOutboundCall[];
  nextUpdateId: number;
  nextMessageId: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTelegramMethodPathSafe(pathname: string): { token: string; method: string } | null {
  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const match = trimmed.match(/^bot([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  const token = (match[1] ?? "").trim();
  const method = (match[2] ?? "").trim();
  if (!token || !method) {
    return null;
  }
  return { token, method };
}

export class TelegramApiMockServer {
  private readonly host: string;
  private readonly port: number;
  private readonly tls?: TelegramApiMockServerOptions["tls"];
  private readonly interception: Required<NonNullable<TelegramApiMockServerOptions["interception"]>>;
  private readonly states = new Map<string, TokenState>();
  private readonly server: ReturnType<typeof createServer> | TlsServer;
  private installedExitCleanup = false;

  constructor(options: TelegramApiMockServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 19090;
    this.tls = options.tls;
    this.interception = {
      enableHostsHijack: options.interception?.enableHostsHijack ?? false,
      hostsFilePath: options.interception?.hostsFilePath ?? "/etc/hosts",
      domain: options.interception?.domain ?? "api.telegram.org",
      ip: options.interception?.ip ?? "127.0.0.1",
      marker: options.interception?.marker ?? "telegram-mock-channel",
    };
    if (this.tls) {
      this.server = createTlsServer(
        {
          cert: readFileSync(this.tls.certPath),
          key: readFileSync(this.tls.keyPath),
        },
        (req, res) => {
          void this.route(req, res);
        },
      );
    } else {
      this.server = createServer((req, res) => {
        void this.route(req, res);
      });
    }
  }

  async start(): Promise<void> {
    if (this.interception.enableHostsHijack) {
      this.applyHostsHijack();
      this.installExitCleanupHandlers();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    if (this.interception.enableHostsHijack) {
      this.removeHostsHijack();
    }
  }

  applyHostsHijack(): void {
    const current = readFileSync(this.interception.hostsFilePath, "utf8");
    const start = `# BEGIN ${this.interception.marker}`;
    const end = `# END ${this.interception.marker}`;
    const nextWithoutOld = this.stripHostsBlock(current, start, end);
    const line = `${this.interception.ip} ${this.interception.domain}`;
    const block = `${start}\n${line}\n${end}\n`;
    const next = `${nextWithoutOld.trimEnd()}\n${block}`;
    writeFileSync(this.interception.hostsFilePath, next, "utf8");
  }

  removeHostsHijack(): void {
    const current = readFileSync(this.interception.hostsFilePath, "utf8");
    const start = `# BEGIN ${this.interception.marker}`;
    const end = `# END ${this.interception.marker}`;
    const next = this.stripHostsBlock(current, start, end);
    writeFileSync(this.interception.hostsFilePath, `${next.trimEnd()}\n`, "utf8");
  }

  private stripHostsBlock(input: string, start: string, end: string): string {
    const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");
    return input.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  }

  private installExitCleanupHandlers(): void {
    if (this.installedExitCleanup) {
      return;
    }
    this.installedExitCleanup = true;
    const cleanup = () => {
      try {
        this.removeHostsHijack();
      } catch {
        // best-effort cleanup
      }
    };
    process.on("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
    process.on("exit", () => {
      cleanup();
    });
  }

  getAddress(): { host: string; port: number } | null {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      return null;
    }
    return {
      host: address.address,
      port: address.port,
    };
  }

  injectUpdate(params: { token: string; update: TelegramUpdate }): TelegramUpdate {
    const tokenState = this.ensureState(params.token);
    const nextId = params.update.update_id ?? tokenState.nextUpdateId;
    tokenState.nextUpdateId = Math.max(tokenState.nextUpdateId, nextId + 1);
    const update = {
      ...params.update,
      update_id: nextId,
    };
    tokenState.updates.push(update);
    return update;
  }

  listOutbound(token: string): TelegramApiMockOutboundCall[] {
    return [...this.ensureState(token).outbound];
  }

  reset(params?: { token?: string; updates?: boolean; outbound?: boolean }): void {
    const updates = params?.updates ?? true;
    const outbound = params?.outbound ?? true;
    if (params?.token) {
      const state = this.ensureState(params.token);
      if (updates) {
        state.updates = [];
      }
      if (outbound) {
        state.outbound = [];
      }
      return;
    }
    for (const state of this.states.values()) {
      if (updates) {
        state.updates = [];
      }
      if (outbound) {
        state.outbound = [];
      }
    }
  }

  private ensureState(token: string): TokenState {
    const existing = this.states.get(token);
    if (existing) {
      return existing;
    }
    const created: TokenState = {
      updates: [],
      outbound: [],
      nextUpdateId: 1,
      nextMessageId: 1,
    };
    this.states.set(token, created);
    return created;
  }

  private recordOutbound(token: string, method: string, payload: Record<string, unknown>): TelegramApiMockOutboundCall {
    const state = this.ensureState(token);
    const call: TelegramApiMockOutboundCall = {
      token,
      method,
      payload,
      ts: nowIso(),
    };
    state.outbound.push(call);
    return call;
  }

  private handleGetUpdates(token: string, payload: Record<string, unknown>): TelegramUpdate[] {
    const state = this.ensureState(token);
    const offset = asNumber(payload.offset) ?? 0;
    const limit = Math.max(1, Math.min(asNumber(payload.limit) ?? 100, 100));
    if (offset > 0) {
      state.updates = state.updates.filter((event) => (event.update_id ?? 0) >= offset);
    }
    return state.updates.filter((event) => (event.update_id ?? 0) >= offset).slice(0, limit);
  }

  private buildMessageResult(token: string, payload: Record<string, unknown>): Record<string, unknown> {
    const state = this.ensureState(token);
    const chatId = asNumber(payload.chat_id) ?? payload.chat_id ?? 0;
    const text = asString(payload.text) ?? "";
    const messageId = state.nextMessageId;
    state.nextMessageId += 1;
    return {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: chatId,
        type: typeof chatId === "number" && chatId < 0 ? "group" : "private",
      },
      text,
    };
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/_mock/health") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/_mock/injectUpdate") {
      const body = await readJsonBody(req);
      const token = asString(body.token);
      if (!token) {
        writeJson(res, 400, { ok: false, error: { code: "MOCK_BAD_REQUEST", message: "Missing token" } });
        return;
      }
      const inputUpdate = body.update && typeof body.update === "object" ? (body.update as TelegramUpdate) : null;
      if (!inputUpdate) {
        writeJson(res, 400, { ok: false, error: { code: "MOCK_BAD_REQUEST", message: "Missing update object" } });
        return;
      }
      const injected = this.injectUpdate({ token, update: inputUpdate });
      writeJson(res, 200, { ok: true, update: injected });
      return;
    }

    if (req.method === "GET" && url.pathname === "/_mock/outbound") {
      const token = asString(url.searchParams.get("token"));
      if (!token) {
        writeJson(res, 400, { ok: false, error: { code: "MOCK_BAD_REQUEST", message: "Missing token query" } });
        return;
      }
      writeJson(res, 200, { ok: true, events: this.listOutbound(token) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/_mock/reset") {
      const body = await readJsonBody(req);
      this.reset({
        token: asString(body.token),
        updates: typeof body.updates === "boolean" ? body.updates : undefined,
        outbound: typeof body.outbound === "boolean" ? body.outbound : undefined,
      });
      writeJson(res, 200, { ok: true, reset: true });
      return;
    }

    const parsed = parseTelegramMethodPathSafe(url.pathname);
    if (!parsed) {
      writeJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
      return;
    }

    const payload = req.method === "GET" ? Object.fromEntries(url.searchParams.entries()) : await readJsonBody(req);
    const { token, method } = parsed;

    if (method === "getMe") {
      writeJson(res, 200, {
        ok: true,
        result: {
          id: 1000000,
          is_bot: true,
          first_name: "MockBot",
          username: `mock_${token.slice(0, 8)}`,
        },
      });
      return;
    }

    if (method === "deleteWebhook") {
      writeJson(res, 200, { ok: true, result: true });
      return;
    }

    if (method === "setWebhook") {
      writeJson(res, 200, { ok: true, result: true });
      return;
    }

    if (method === "getWebhookInfo") {
      writeJson(res, 200, {
        ok: true,
        result: {
          url: "",
          has_custom_certificate: false,
          pending_update_count: 0,
        },
      });
      return;
    }

    if (method === "getUpdates") {
      const updates = this.handleGetUpdates(token, payload);
      writeJson(res, 200, {
        ok: true,
        result: updates,
      });
      return;
    }

    if (method === "sendMessage") {
      this.recordOutbound(token, method, payload);
      writeJson(res, 200, {
        ok: true,
        result: this.buildMessageResult(token, payload),
      });
      return;
    }

    if (method === "editMessageText") {
      this.recordOutbound(token, method, payload);
      writeJson(res, 200, {
        ok: true,
        result: {
          message_id: asNumber(payload.message_id) ?? 1,
          chat: {
            id: asNumber(payload.chat_id) ?? payload.chat_id ?? 0,
            type: "private",
          },
          text: asString(payload.text) ?? "",
        },
      });
      return;
    }

    if (method === "answerCallbackQuery") {
      this.recordOutbound(token, method, payload);
      writeJson(res, 200, {
        ok: true,
        result: true,
      });
      return;
    }

    writeJson(res, 404, {
      ok: false,
      error_code: 404,
      description: `Method ${method} not mocked`,
    });
  }
}

export type { TelegramApiMockServerOptions };
