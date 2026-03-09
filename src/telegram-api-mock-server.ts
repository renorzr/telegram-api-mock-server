import { request as httpRequest } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve4 } from "node:dns/promises";

export type TelegramApiMockMode = "mock" | "passthrough";

export type TelegramApiMockServerOptions = {
  host?: string;
  port?: number;
  mode?: TelegramApiMockMode;
  admin?: {
    token?: string;
  };
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
  passthrough?: {
    upstreamBaseUrl?: string;
    timeoutMs?: number;
    bypassHostsForTelegramDomain?: boolean;
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

function parseTelegramMethodPath(pathname: string): { token: string; method: string } | null {
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

function hasAdminAccess(req: IncomingMessage, token?: string): boolean {
  if (!token) {
    return true;
  }
  const bearer = req.headers.authorization;
  if (bearer === `Bearer ${token}`) {
    return true;
  }
  return req.headers["x-admin-token"] === token;
}

export class TelegramApiMockServer {
  private readonly host: string;
  private readonly port: number;
  private mode: TelegramApiMockMode;
  private readonly adminToken?: string;
  private readonly tls?: TelegramApiMockServerOptions["tls"];
  private readonly interception: Required<NonNullable<TelegramApiMockServerOptions["interception"]>>;
  private readonly upstreamBaseUrl: URL;
  private readonly passthroughTimeoutMs: number;
  private readonly bypassHostsForTelegramDomain: boolean;
  private readonly states = new Map<string, TokenState>();
  private readonly server: ReturnType<typeof createServer> | TlsServer;
  private installedExitCleanup = false;
  private cachedTelegramIp: string | null = null;

  constructor(options: TelegramApiMockServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 19090;
    this.mode = options.mode ?? "mock";
    this.adminToken = options.admin?.token?.trim() || undefined;
    this.tls = options.tls;
    this.interception = {
      enableHostsHijack: options.interception?.enableHostsHijack ?? false,
      hostsFilePath: options.interception?.hostsFilePath ?? "/etc/hosts",
      domain: options.interception?.domain ?? "api.telegram.org",
      ip: options.interception?.ip ?? "127.0.0.1",
      marker: options.interception?.marker ?? "telegram-api-mock-server",
    };
    this.upstreamBaseUrl = new URL(options.passthrough?.upstreamBaseUrl ?? "https://api.telegram.org");
    this.passthroughTimeoutMs = options.passthrough?.timeoutMs ?? 15000;
    this.bypassHostsForTelegramDomain = options.passthrough?.bypassHostsForTelegramDomain ?? true;

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
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.port, this.host, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      if (this.interception.enableHostsHijack) {
        this.removeHostsHijack();
      }
      throw error;
    }
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

  getMode(): TelegramApiMockMode {
    return this.mode;
  }

  setMode(mode: TelegramApiMockMode): void {
    this.mode = mode;
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
    process.once("exit", () => {
      try {
        this.removeHostsHijack();
      } catch {
        // best-effort cleanup
      }
    });
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

  private recordOutbound(token: string, method: string, payload: Record<string, unknown>): void {
    const state = this.ensureState(token);
    const call: TelegramApiMockOutboundCall = {
      token,
      method,
      payload,
      ts: nowIso(),
    };
    state.outbound.push(call);
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

  private async resolveTelegramApiIp(): Promise<string> {
    if (this.cachedTelegramIp) {
      return this.cachedTelegramIp;
    }
    const addresses = await resolve4("api.telegram.org");
    if (addresses.length === 0) {
      throw new Error("Failed to resolve api.telegram.org");
    }
    this.cachedTelegramIp = addresses[0] ?? null;
    if (!this.cachedTelegramIp) {
      throw new Error("Failed to resolve api.telegram.org");
    }
    return this.cachedTelegramIp;
  }

  private async passthroughTelegramRequest(params: {
    reqMethod: string;
    token: string;
    method: string;
    payload: Record<string, unknown>;
    res: ServerResponse;
  }): Promise<void> {
    const target = new URL(`/bot${params.token}/${params.method}`, this.upstreamBaseUrl);
    if (params.reqMethod === "GET") {
      for (const [key, value] of Object.entries(params.payload)) {
        if (value == null) {
          continue;
        }
        target.searchParams.set(key, String(value));
      }
    }

    const client = target.protocol === "https:" ? httpsRequest : httpRequest;
    const body = params.reqMethod === "GET" ? undefined : JSON.stringify(params.payload);

    const forcedIp =
      this.bypassHostsForTelegramDomain && target.hostname === "api.telegram.org" && target.protocol === "https:"
        ? await this.resolveTelegramApiIp()
        : undefined;

    await new Promise<void>((resolve, reject) => {
      const upstreamReq = client(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port ? Number(target.port) : undefined,
          path: `${target.pathname}${target.search}`,
          method: params.reqMethod,
          timeout: this.passthroughTimeoutMs,
          headers: {
            "content-type": "application/json",
          },
          servername: target.hostname,
          lookup: forcedIp
            ? (hostname, _options, callback) => {
                callback(null, forcedIp, 4);
              }
            : undefined,
        },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          upstreamRes.on("end", () => {
            params.res.statusCode = upstreamRes.statusCode ?? 502;
            params.res.setHeader("content-type", upstreamRes.headers["content-type"] ?? "application/json");
            params.res.end(Buffer.concat(chunks));
            resolve();
          });
        },
      );
      upstreamReq.on("error", reject);
      if (body) {
        upstreamReq.write(body);
      }
      upstreamReq.end();
    }).catch((error) => {
      writeJson(params.res, 502, {
        ok: false,
        error_code: 502,
        description: `Passthrough request failed: ${String(error)}`,
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/_admin/status") {
      if (!hasAdminAccess(req, this.adminToken)) {
        writeJson(res, 401, { ok: false, error: { code: "MOCK_AUTH_INVALID", message: "Admin token invalid" } });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        mode: this.mode,
        interception: this.interception.enableHostsHijack,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/_admin/mode") {
      if (!hasAdminAccess(req, this.adminToken)) {
        writeJson(res, 401, { ok: false, error: { code: "MOCK_AUTH_INVALID", message: "Admin token invalid" } });
        return;
      }
      const body = await readJsonBody(req);
      const mode = asString(body.mode);
      if (mode !== "mock" && mode !== "passthrough") {
        writeJson(res, 400, {
          ok: false,
          error: { code: "MOCK_BAD_REQUEST", message: "mode must be 'mock' or 'passthrough'" },
        });
        return;
      }
      this.mode = mode;
      writeJson(res, 200, { ok: true, mode: this.mode });
      return;
    }

    if (url.pathname === "/_mock/health") {
      writeJson(res, 200, { ok: true, mode: this.mode });
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

    const parsed = parseTelegramMethodPath(url.pathname);
    if (!parsed) {
      writeJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
      return;
    }

    const payload = req.method === "GET" ? Object.fromEntries(url.searchParams.entries()) : await readJsonBody(req);
    const { token, method } = parsed;

    if (this.mode === "passthrough") {
      await this.passthroughTelegramRequest({
        reqMethod: req.method ?? "POST",
        token,
        method,
        payload,
        res,
      });
      return;
    }

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

    if (method === "deleteWebhook" || method === "setWebhook") {
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
