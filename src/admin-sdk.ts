import type { TelegramApiMockMode } from "./telegram-api-mock-server.js";

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
  baseUrl: string;
  adminToken?: string;
  fetchImpl?: typeof fetch;
};

export type TelegramApiMockAdminStatus = {
  ok: true;
  mode: TelegramApiMockMode;
  interception: boolean;
};

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function createTelegramApiMockAdminClient(options: TelegramApiMockAdminClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = trimSlash(options.baseUrl);

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (options.adminToken?.trim()) {
      headers["x-admin-token"] = options.adminToken.trim();
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
  };
}

export type TelegramApiMockAdminClient = ReturnType<typeof createTelegramApiMockAdminClient>;
