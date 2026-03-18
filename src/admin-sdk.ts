import type { TelegramApiMockMode } from "./telegram-api-mock-server.js";

export type TelegramApiMockRequestLog = {
  id: number;
  ts: string;
  plane: "api" | "admin";
  method: string;
  path: string;
  status: number;
  durationMs: number;
  mode: TelegramApiMockMode;
  tokenHint?: string;
  error?: string;
  updatesCount?: number;
  latestUpdateType?: string;
  textPreview?: string;
};

export class TelegramApiMockAdminError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(params: { status: number; code: string; message: string }) {
    super(params.message);
    this.status = params.status;
    this.code = params.code;
  }
}

export type TelegramApiMockAdminClientOptions = {
  baseUrl?: string;
  adminToken?: string;
  fetchImpl?: typeof fetch;
};

export type TelegramApiMockAdminStatus = {
  ok: true;
  mode: TelegramApiMockMode;
  interceptionConfigured: boolean;
  hostsHijackActive: boolean;
};

export type TelegramApiMockInjectUpdateResponse = {
  ok: true;
  update: Record<string, unknown>;
};

export type TelegramApiMockListOutboundResponse = {
  ok: true;
  events: Array<{
    token: string;
    method: string;
    payload: Record<string, unknown>;
    ts: string;
  }>;
};

export type TelegramApiMockResetResponse = {
  ok: true;
  reset: true;
};

export type TelegramApiMockHealthResponse = {
  ok: true;
  mode: TelegramApiMockMode;
};

export type TelegramApiMockListLogsResponse = {
  ok: true;
  logs: TelegramApiMockRequestLog[];
  nextSinceId: number;
};

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const DEFAULT_ADMIN_BASE_URL = "http://127.0.0.1:19091";
const ENV_ADMIN_BASE_URL = "TELEGRAM_API_MOCK_ADMIN_BASE_URL";
const ENV_ADMIN_TOKEN = "TELEGRAM_API_MOCK_ADMIN_TOKEN";

export function createTelegramApiMockAdminClient(options: TelegramApiMockAdminClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = trimSlash(options.baseUrl ?? process.env[ENV_ADMIN_BASE_URL] ?? DEFAULT_ADMIN_BASE_URL);
  const adminToken = options.adminToken ?? process.env[ENV_ADMIN_TOKEN];

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (adminToken?.trim()) {
      headers["x-admin-token"] = adminToken.trim();
    }
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers,
    });
    const body = (await res.json()) as
      | T
      | { ok?: boolean; error?: { code?: string; message?: string } }
      | { description?: string };
    if (!res.ok) {
      const code =
        typeof body === "object" && body && "error" in body && body.error?.code
          ? body.error.code
          : "MOCK_HTTP_ERROR";
      const message =
        typeof body === "object" && body && "error" in body && body.error?.message
          ? body.error.message
          : typeof body === "object" && body && "description" in body && typeof body.description === "string"
            ? body.description
            : `HTTP ${res.status}`;
      throw new TelegramApiMockAdminError({
        status: res.status,
        code,
        message,
      });
    }
    return body as T;
  }

  async function setMode(mode: TelegramApiMockMode): Promise<{ ok: true; mode: TelegramApiMockMode }> {
    return request<{ ok: true; mode: TelegramApiMockMode }>("/_admin/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  }

  return {
    async getStatus(): Promise<TelegramApiMockAdminStatus> {
      return request<TelegramApiMockAdminStatus>("/_admin/status", { method: "GET" });
    },
    setMode,
    async enableMock(): Promise<{ ok: true; mode: TelegramApiMockMode }> {
      return setMode("mock");
    },
    async disableMock(): Promise<{ ok: true; mode: TelegramApiMockMode }> {
      return setMode("passthrough");
    },
    async injectUpdate(input: {
      token: string;
      update: Record<string, unknown>;
    }): Promise<TelegramApiMockInjectUpdateResponse> {
      return request<TelegramApiMockInjectUpdateResponse>("/_mock/injectUpdate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    async listOutbound(token: string): Promise<TelegramApiMockListOutboundResponse> {
      return request<TelegramApiMockListOutboundResponse>(`/_mock/outbound?token=${encodeURIComponent(token)}`, {
        method: "GET",
      });
    },
    async reset(input?: { token?: string; updates?: boolean; outbound?: boolean }): Promise<TelegramApiMockResetResponse> {
      return request<TelegramApiMockResetResponse>("/_mock/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
      });
    },
    async health(): Promise<TelegramApiMockHealthResponse> {
      return request<TelegramApiMockHealthResponse>("/_mock/health", { method: "GET" });
    },
    async listLogs(input?: { limit?: number; sinceId?: number }): Promise<TelegramApiMockListLogsResponse> {
      const search = new URLSearchParams();
      if (input?.limit != null) {
        search.set("limit", String(input.limit));
      }
      if (input?.sinceId != null) {
        search.set("sinceId", String(input.sinceId));
      }
      const suffix = search.size > 0 ? `?${search.toString()}` : "";
      return request<TelegramApiMockListLogsResponse>(`/_mock/logs${suffix}`, { method: "GET" });
    },
  };
}

export type TelegramApiMockAdminClient = ReturnType<typeof createTelegramApiMockAdminClient>;
