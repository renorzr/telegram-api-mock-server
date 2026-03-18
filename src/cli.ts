#!/usr/bin/env node
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { TelegramApiMockServer, type TelegramApiMockMode } from "./telegram-api-mock-server.js";

type InterceptMode = "hosts" | "nftables";
type MockCommandAction = "on" | "off";

type CliOptions = {
  host: string;
  port: number;
  redirectPort: number;
  mode: TelegramApiMockMode;
  interceptMode: InterceptMode;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  certDir: string;
  enableHostsHijack: boolean;
  hostsFilePath: string;
  domain: string;
  ip: string;
  marker: string;
  nftTable: string;
  nftChain: string;
  nftSet: string;
  matchUid?: number;
  refreshSeconds: number;
  adminToken?: string;
  adminHost: string;
  adminPort: number;
  upstreamBaseUrl?: string;
  serviceName: string;
  logLimit: number;
  logFollow: boolean;
  logJson: boolean;
  logPollMs: number;
  noSudoReexec: boolean;
};

const DEFAULTS: CliOptions = {
  host: "127.0.0.1",
  port: 19090,
  redirectPort: 19090,
  mode: "passthrough",
  interceptMode: "nftables",
  certDir: "/etc/telegram-mock",
  enableHostsHijack: false,
  hostsFilePath: "/etc/hosts",
  domain: "api.telegram.org",
  ip: "127.0.0.1",
  marker: "telegram-api-mock-server",
  nftTable: "telegram_mock",
  nftChain: "out_redirect",
  nftSet: "telegram_api_targets",
  refreshSeconds: 60,
  adminHost: "127.0.0.1",
  adminPort: 19091,
  serviceName: "telegram-api-mock-server",
  logLimit: 100,
  logFollow: false,
  logJson: false,
  logPollMs: 1000,
  noSudoReexec: false,
};

function printHelp(): void {
  process.stdout.write(
    [
      "telegram-api-mock-server",
      "",
      "Commands:",
      "  start             Start server in foreground",
      "  bootstrap         Generate certs and prepare interception",
      "  install-service   Install and start systemd service",
      "  uninstall-service Stop and remove systemd service",
      "  status            Show runtime/install status",
      "  mock <on|off>     Toggle runtime mock mode",
      "  logs              Read runtime request logs",
      "",
      "Common options:",
      "  --host <host>                    Bind host (default: 127.0.0.1)",
      "  --port <port>                    Bind port (default: 19090)",
      "  --redirect-port <port>           Redirect destination port (default: 19090)",
      "  --mode <mock|passthrough>        Initial mode (default: passthrough)",
      "  --intercept-mode <hosts|nftables> Interception mode (default: nftables)",
      "  --admin-token <token>            Token for /_admin endpoints",
      "  --enable-hosts-hijack            Add hosts entry for api.telegram.org",
      "  --hosts-file <path>              Hosts file path (default: /etc/hosts)",
      "  --domain <domain>                Hijack domain (default: api.telegram.org)",
      "  --ip <ip>                        Hijack destination IP (default: 127.0.0.1)",
      "  --marker <name>                  Hosts marker name",
      "  --nft-table <name>               nftables table name",
      "  --nft-chain <name>               nftables chain name",
      "  --nft-set <name>                 nftables set name",
      "  --match-uid <uid>                Restrict redirect to process UID",
      "  --refresh-seconds <n>            nftables target refresh interval (default: 60)",
      "  --admin-host <host>              Admin HTTP bind host (default: 127.0.0.1)",
      "  --admin-port <port>              Admin HTTP bind port (default: 19091)",
      "  --cert-dir <path>                Cert directory (default: /etc/telegram-mock)",
      "  --tls-cert <path>                TLS cert path (default: <cert-dir>/<domain>.crt)",
      "  --tls-key <path>                 TLS key path (default: <cert-dir>/<domain>.key)",
      "  --upstream-base-url <url>        Passthrough upstream URL",
      "  --service-name <name>            systemd service name",
      "  --limit <n>                      Logs limit (default: 100)",
      "  --follow                         Follow logs (for logs command)",
      "  --json                           Print raw JSON logs",
      "  --poll-ms <ms>                   Follow poll interval (default: 1000)",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      options.host = next;
      i += 1;
      continue;
    }
    if (arg === "--port" && next) {
      options.port = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--redirect-port" && next) {
      options.redirectPort = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--mode" && next && (next === "mock" || next === "passthrough")) {
      options.mode = next;
      i += 1;
      continue;
    }
    if (arg === "--admin-token" && next) {
      options.adminToken = next;
      i += 1;
      continue;
    }
    if (arg === "--admin-host" && next) {
      options.adminHost = next;
      i += 1;
      continue;
    }
    if (arg === "--admin-port" && next) {
      options.adminPort = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--intercept-mode" && next && (next === "hosts" || next === "nftables")) {
      options.interceptMode = next;
      i += 1;
      continue;
    }
    if (arg === "--enable-hosts-hijack") {
      options.enableHostsHijack = true;
      continue;
    }
    if (arg === "--hosts-file" && next) {
      options.hostsFilePath = next;
      i += 1;
      continue;
    }
    if (arg === "--domain" && next) {
      options.domain = next;
      i += 1;
      continue;
    }
    if (arg === "--ip" && next) {
      options.ip = next;
      i += 1;
      continue;
    }
    if (arg === "--marker" && next) {
      options.marker = next;
      i += 1;
      continue;
    }
    if (arg === "--nft-table" && next) {
      options.nftTable = next;
      i += 1;
      continue;
    }
    if (arg === "--nft-chain" && next) {
      options.nftChain = next;
      i += 1;
      continue;
    }
    if (arg === "--nft-set" && next) {
      options.nftSet = next;
      i += 1;
      continue;
    }
    if (arg === "--match-uid" && next) {
      options.matchUid = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--refresh-seconds" && next) {
      options.refreshSeconds = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--cert-dir" && next) {
      options.certDir = next;
      i += 1;
      continue;
    }
    if (arg === "--tls-cert" && next) {
      options.tlsCertPath = next;
      i += 1;
      continue;
    }
    if (arg === "--tls-key" && next) {
      options.tlsKeyPath = next;
      i += 1;
      continue;
    }
    if (arg === "--upstream-base-url" && next) {
      options.upstreamBaseUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--service-name" && next) {
      options.serviceName = next;
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      options.logLimit = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--follow") {
      options.logFollow = true;
      continue;
    }
    if (arg === "--json") {
      options.logJson = true;
      continue;
    }
    if (arg === "--poll-ms" && next) {
      options.logPollMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--no-sudo-reexec") {
      options.noSudoReexec = true;
      continue;
    }
    throw new Error(`Unknown or invalid argument: ${arg}`);
  }
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive number");
  }
  if (!Number.isFinite(options.redirectPort) || options.redirectPort <= 0) {
    throw new Error("--redirect-port must be a positive number");
  }
  if (options.matchUid != null && (!Number.isFinite(options.matchUid) || options.matchUid < 0)) {
    throw new Error("--match-uid must be a non-negative number");
  }
  if (!Number.isFinite(options.refreshSeconds) || options.refreshSeconds < 5) {
    throw new Error("--refresh-seconds must be at least 5");
  }
  if (!Number.isFinite(options.adminPort) || options.adminPort <= 0) {
    throw new Error("--admin-port must be a positive number");
  }
  if (!Number.isFinite(options.logLimit) || options.logLimit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  if (!Number.isFinite(options.logPollMs) || options.logPollMs < 200) {
    throw new Error("--poll-ms must be at least 200");
  }
  if ((options.tlsCertPath && !options.tlsKeyPath) || (!options.tlsCertPath && options.tlsKeyPath)) {
    throw new Error("--tls-cert and --tls-key must be provided together");
  }
  return options;
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with code ${result.status ?? "unknown"}`);
  }
}

function runCommandNoThrow(command: string, args: string[]): number {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status ?? 1;
}

function runCommandCapture(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function buildAdminHeaders(options: CliOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.adminToken?.trim()) {
    headers["x-admin-token"] = options.adminToken.trim();
  }
  return headers;
}

async function getMockRuntimeState(options: CliOptions): Promise<{
  mockReachable: boolean;
  mockMode: TelegramApiMockMode | null;
  mockEnabled: boolean | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 2000);
  try {
    const response = await fetch(`http://${options.adminHost}:${options.adminPort}/_mock/health`, {
      method: "GET",
      headers: buildAdminHeaders(options),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        mockReachable: false,
        mockMode: null,
        mockEnabled: null,
      };
    }
    const payload = (await response.json()) as { mode?: unknown };
    const mode = payload.mode === "mock" || payload.mode === "passthrough" ? payload.mode : null;
    return {
      mockReachable: mode !== null,
      mockMode: mode,
      mockEnabled: mode === null ? null : mode === "mock",
    };
  } catch {
    return {
      mockReachable: false,
      mockMode: null,
      mockEnabled: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function setMockMode(options: CliOptions, mode: TelegramApiMockMode): Promise<void> {
  const response = await fetch(`http://${options.adminHost}:${options.adminPort}/_admin/mode`, {
    method: "POST",
    headers: {
      ...buildAdminHeaders(options),
      "content-type": "application/json",
    },
    body: JSON.stringify({ mode }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) {
    const message = body.error?.message ?? `Admin API returned HTTP ${response.status}`;
    throw new Error(message);
  }
}

type CliRequestLog = {
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

async function fetchRequestLogs(
  options: CliOptions,
  params: { sinceId: number; limit?: number },
): Promise<{ logs: CliRequestLog[]; nextSinceId: number }> {
  const query = new URLSearchParams();
  query.set("sinceId", String(params.sinceId));
  if (params.limit != null) {
    query.set("limit", String(params.limit));
  }
  const response = await fetch(`http://${options.adminHost}:${options.adminPort}/_mock/logs?${query.toString()}`, {
    method: "GET",
    headers: buildAdminHeaders(options),
  });
  const body = (await response.json().catch(() => ({}))) as {
    logs?: CliRequestLog[];
    nextSinceId?: number;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Admin API returned HTTP ${response.status}`);
  }
  return {
    logs: Array.isArray(body.logs) ? body.logs : [],
    nextSinceId: typeof body.nextSinceId === "number" ? body.nextSinceId : params.sinceId,
  };
}

function formatLogLine(log: CliRequestLog): string {
  const parts = [
    `[${log.ts}]`,
    `${log.plane}`,
    `${log.method}`,
    `${log.path}`,
    `status=${log.status}`,
    `dur=${log.durationMs}ms`,
    `mode=${log.mode}`,
  ];
  if (log.tokenHint) {
    parts.push(`token=${log.tokenHint}`);
  }
  if (log.error) {
    parts.push(`error=${log.error}`);
  }
  if (typeof log.updatesCount === "number") {
    parts.push(`updates=${log.updatesCount}`);
  }
  if (log.latestUpdateType) {
    parts.push(`latestType=${log.latestUpdateType}`);
  }
  if (log.textPreview) {
    parts.push(`text=${JSON.stringify(log.textPreview)}`);
  }
  return parts.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function maybeRunSudo(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with code ${result.status ?? "unknown"}`);
  }
}

function ensureWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureSudoIfNeeded(needsRoot: boolean): void {
  if (!needsRoot) {
    return;
  }
  const uid = process.getuid ? process.getuid() : 0;
  if (uid === 0) {
    return;
  }
  if (process.argv.includes("--no-sudo-reexec")) {
    throw new Error("Operation requires root privileges");
  }
  const scriptPath = new URL(import.meta.url).pathname;
  const nextArgs = process.argv.slice(2).concat("--no-sudo-reexec");
  const result = spawnSync("sudo", [process.execPath, scriptPath, ...nextArgs], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function resolveTlsPaths(options: CliOptions): { certPath: string; keyPath: string; caPath: string; caKeyPath: string } {
  const certPath = options.tlsCertPath ?? `${options.certDir}/${options.domain}.crt`;
  const keyPath = options.tlsKeyPath ?? `${options.certDir}/${options.domain}.key`;
  const caPath = `${options.certDir}/test-ca.crt`;
  const caKeyPath = `${options.certDir}/test-ca.key`;
  return { certPath, keyPath, caPath, caKeyPath };
}

function ensureOpenSslInstalled(): void {
  const check = spawnSync("openssl", ["version"], { stdio: "ignore" });
  if (check.status !== 0) {
    throw new Error("openssl is required for bootstrap");
  }
}

function bootstrapCertificates(options: CliOptions): { certPath: string; keyPath: string; caPath: string } {
  ensureOpenSslInstalled();
  mkdirSync(options.certDir, { recursive: true });
  const { certPath, keyPath, caPath, caKeyPath } = resolveTlsPaths(options);
  const csrPath = `${options.certDir}/${options.domain}.csr`;
  const extPath = `${options.certDir}/${options.domain}.ext`;

  if (!existsSync(caPath) || !existsSync(caKeyPath)) {
    runCommand("openssl", ["genrsa", "-out", caKeyPath, "2048"]);
    runCommand("openssl", [
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-key",
      caKeyPath,
      "-sha256",
      "-days",
      "3650",
      "-out",
      caPath,
      "-subj",
      "/CN=telegram-api-mock-server Test CA",
    ]);
    chmodSync(caKeyPath, 0o600);
  }

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    runCommand("openssl", ["genrsa", "-out", keyPath, "2048"]);
    runCommand("openssl", ["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${options.domain}`]);
    writeFileSync(
      extPath,
      [
        "authorityKeyIdentifier=keyid,issuer",
        "basicConstraints=CA:FALSE",
        "keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = DNS:${options.domain}`,
      ].join("\n"),
      "utf8",
    );
    runCommand("openssl", [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      certPath,
      "-days",
      "825",
      "-sha256",
      "-extfile",
      extPath,
    ]);
    chmodSync(keyPath, 0o600);
  }

  return { certPath, keyPath, caPath };
}

function applyHostsHijackOnce(options: CliOptions): void {
  const helper = new TelegramApiMockServer({
    host: options.host,
    port: options.port,
    tls: {
      certPath: resolveTlsPaths(options).certPath,
      keyPath: resolveTlsPaths(options).keyPath,
    },
    interception: {
      enableHostsHijack: true,
      hostsFilePath: options.hostsFilePath,
      domain: options.domain,
      ip: options.ip,
      marker: options.marker,
    },
  });
  helper.applyHostsHijack();
}

async function resolveTargetIps(domain: string): Promise<string[]> {
  const ips = await resolve4(domain);
  const unique = Array.from(new Set(ips.filter((value) => value && value.trim().length > 0)));
  if (unique.length === 0) {
    throw new Error(`No IPv4 records found for ${domain}`);
  }
  return unique;
}

async function applyNftablesRedirect(options: CliOptions): Promise<void> {
  const ips = await resolveTargetIps(options.domain);
  runCommandNoThrow("nft", ["add", "table", "inet", options.nftTable]);
  runCommandNoThrow("nft", ["add", "set", "inet", options.nftTable, options.nftSet, "{", "type", "ipv4_addr", ";", "}"]);
  runCommand("nft", ["flush", "set", "inet", options.nftTable, options.nftSet]);
  runCommand("nft", ["add", "element", "inet", options.nftTable, options.nftSet, "{", ips.join(","), "}"]);
  runCommandNoThrow("nft", [
    "add",
    "chain",
    "inet",
    options.nftTable,
    options.nftChain,
    "{",
    "type",
    "nat",
    "hook",
    "output",
    "priority",
    "dstnat",
    ";",
    "policy",
    "accept",
    ";",
    "}",
  ]);
  runCommand("nft", ["flush", "chain", "inet", options.nftTable, options.nftChain]);
  const ruleArgs = ["add", "rule", "inet", options.nftTable, options.nftChain];
  if (options.matchUid != null) {
    ruleArgs.push("meta", "skuid", String(options.matchUid));
  }
  ruleArgs.push(
    "ip",
    "daddr",
    `@${options.nftSet}`,
    "tcp",
    "dport",
    "443",
    "redirect",
    "to",
    `:${options.redirectPort}`,
    "comment",
    options.marker,
  );
  runCommand("nft", ruleArgs);
}

function removeNftablesRedirect(options: CliOptions): void {
  runCommandNoThrow("nft", ["delete", "table", "inet", options.nftTable]);
}

function isNftablesRedirectActive(options: CliOptions): boolean {
  const listed = runCommandCapture("nft", ["list", "table", "inet", options.nftTable]);
  if (listed.status === 0) {
    return listed.stdout.includes(options.nftSet) && listed.stdout.includes(`redirect to :${options.redirectPort}`);
  }
  const listedSudo = runCommandCapture("sudo", ["-n", "nft", "list", "table", "inet", options.nftTable]);
  if (listedSudo.status === 0) {
    return listedSudo.stdout.includes(options.nftSet) && listedSudo.stdout.includes(`redirect to :${options.redirectPort}`);
  }
  return false;
}

function canInspectNftables(options: CliOptions): boolean {
  const listed = runCommandCapture("nft", ["list", "tables"]);
  if (listed.status === 0) {
    return true;
  }
  const listedSudo = runCommandCapture("sudo", ["-n", "nft", "list", "tables"]);
  if (listedSudo.status === 0) {
    return true;
  }
  return false;
}

function buildServiceUnit(options: CliOptions): string {
  const scriptPath = new URL(import.meta.url).pathname;
  const tls = resolveTlsPaths(options);
  const args = [
    "start",
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--redirect-port",
    String(options.redirectPort),
    "--mode",
    options.mode,
    "--intercept-mode",
    options.interceptMode,
    "--tls-cert",
    tls.certPath,
    "--tls-key",
    tls.keyPath,
    "--domain",
    options.domain,
    "--ip",
    options.ip,
    "--marker",
    options.marker,
    "--hosts-file",
    options.hostsFilePath,
    "--nft-table",
    options.nftTable,
    "--nft-chain",
    options.nftChain,
    "--nft-set",
    options.nftSet,
    "--refresh-seconds",
    String(options.refreshSeconds),
    "--admin-host",
    options.adminHost,
    "--admin-port",
    String(options.adminPort),
    "--cert-dir",
    options.certDir,
    "--no-sudo-reexec",
  ];
  if (options.enableHostsHijack) {
    args.push("--enable-hosts-hijack");
  }
  if (options.matchUid != null) {
    args.push("--match-uid", String(options.matchUid));
  }
  if (options.adminToken) {
    args.push("--admin-token", options.adminToken);
  }
  if (options.upstreamBaseUrl) {
    args.push("--upstream-base-url", options.upstreamBaseUrl);
  }

  const exec = [process.execPath, scriptPath, ...args].join(" ");
  return [
    "[Unit]",
    "Description=Telegram API Mock Server",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    `WorkingDirectory=${process.cwd()}`,
    `Environment=NODE_EXTRA_CA_CERTS=${tls.caPath}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function getServicePath(serviceName: string): string {
  return `/etc/systemd/system/${serviceName}.service`;
}

async function commandBootstrap(options: CliOptions): Promise<void> {
  ensureSudoIfNeeded(true);
  const tls = bootstrapCertificates(options);
  if (options.interceptMode === "hosts" && options.enableHostsHijack) {
    applyHostsHijackOnce(options);
  }
  if (options.interceptMode === "nftables") {
    await applyNftablesRedirect(options);
  }
  process.stdout.write(`[telegram-api-mock-server] bootstrap complete cert=${tls.certPath} ca=${tls.caPath}\n`);
}

async function commandInstallService(options: CliOptions): Promise<void> {
  ensureSudoIfNeeded(true);
  bootstrapCertificates(options);
  const serviceOptions: CliOptions = {
    ...options,
    mode: "mock",
  };
  const unit = buildServiceUnit(serviceOptions);
  const path = getServicePath(options.serviceName);
  writeFileSync(path, unit, "utf8");
  maybeRunSudo("systemctl", ["daemon-reload"]);
  maybeRunSudo("systemctl", ["enable", "--now", `${options.serviceName}.service`]);
  process.stdout.write(`[telegram-api-mock-server] service installed: ${options.serviceName} mode=mock\n`);
}

async function commandUninstallService(options: CliOptions): Promise<void> {
  ensureSudoIfNeeded(true);
  maybeRunSudo("systemctl", ["disable", "--now", `${options.serviceName}.service`]);
  if (options.interceptMode === "nftables") {
    removeNftablesRedirect(options);
  }
  const path = getServicePath(options.serviceName);
  runCommand("rm", ["-f", path]);
  maybeRunSudo("systemctl", ["daemon-reload"]);
  process.stdout.write(`[telegram-api-mock-server] service removed: ${options.serviceName}\n`);
}

async function commandStatus(options: CliOptions): Promise<void> {
  const servicePath = getServicePath(options.serviceName);
  const serviceInstalled = existsSync(servicePath);
  const active = spawnSync("systemctl", ["is-active", `${options.serviceName}.service`], { stdio: "ignore" }).status === 0;
  const tls = resolveTlsPaths(options);
  const certReady = existsSync(tls.certPath) && existsSync(tls.keyPath) && existsSync(tls.caPath);
  let hostsHijackActive = false;
  try {
    const content = readFileSync(options.hostsFilePath, "utf8");
    hostsHijackActive =
      content.includes(`# BEGIN ${options.marker}`) &&
      content.includes(`# END ${options.marker}`) &&
      content.includes(`${options.ip} ${options.domain}`);
  } catch {
    hostsHijackActive = false;
  }
  const nftablesRedirectActive = isNftablesRedirectActive(options);
  const nftablesInspectable = canInspectNftables(options);
  const mockState = await getMockRuntimeState(options);
  process.stdout.write(
    `${JSON.stringify({
      serviceInstalled,
      serviceActive: active,
      certReady,
      interceptMode: options.interceptMode,
      hostsWritable: ensureWritable(options.hostsFilePath),
      hostsHijackActive,
      nftablesRedirectActive,
      nftablesInspectable,
      refreshSeconds: options.refreshSeconds,
      adminHost: options.adminHost,
      adminPort: options.adminPort,
      serviceName: options.serviceName,
      certDir: options.certDir,
      caPath: tls.caPath,
      mockReachable: mockState.mockReachable,
      mockMode: mockState.mockMode,
      mockEnabled: mockState.mockEnabled,
    })}\n`,
  );
}

async function commandMock(options: CliOptions, action: MockCommandAction): Promise<void> {
  const mode: TelegramApiMockMode = action === "on" ? "mock" : "passthrough";
  await setMockMode(options, mode);
  process.stdout.write(`[telegram-api-mock-server] mode=${mode}\n`);
}

async function commandLogs(options: CliOptions): Promise<void> {
  let sinceId = 0;
  const firstBatch = await fetchRequestLogs(options, { sinceId, limit: options.logLimit });
  sinceId = firstBatch.nextSinceId;
  if (options.logJson) {
    process.stdout.write(`${JSON.stringify(firstBatch.logs)}\n`);
  } else {
    for (const log of firstBatch.logs) {
      process.stdout.write(`${formatLogLine(log)}\n`);
    }
  }

  if (!options.logFollow) {
    return;
  }

  while (true) {
    await sleep(options.logPollMs);
    const nextBatch = await fetchRequestLogs(options, { sinceId });
    sinceId = nextBatch.nextSinceId;
    if (nextBatch.logs.length === 0) {
      continue;
    }
    if (options.logJson) {
      process.stdout.write(`${JSON.stringify(nextBatch.logs)}\n`);
      continue;
    }
    for (const log of nextBatch.logs) {
      process.stdout.write(`${formatLogLine(log)}\n`);
    }
  }
}

async function commandStart(options: CliOptions): Promise<void> {
  const needsRoot =
    (options.interceptMode === "hosts" && options.enableHostsHijack) ||
    options.interceptMode === "nftables" ||
    options.port < 1024;
  ensureSudoIfNeeded(needsRoot);
  const tls = bootstrapCertificates(options);

  if (options.interceptMode === "nftables") {
    await applyNftablesRedirect(options);
  }

  const server = new TelegramApiMockServer({
    host: options.host,
    port: options.port,
    mode: options.mode,
    admin: {
      token: options.adminToken,
      host: options.adminHost,
      port: options.adminPort,
    },
    tls: { certPath: tls.certPath, keyPath: tls.keyPath },
    interception: {
      enableHostsHijack: options.interceptMode === "hosts" ? options.enableHostsHijack : false,
      hostsFilePath: options.hostsFilePath,
      domain: options.domain,
      ip: options.ip,
      marker: options.marker,
    },
    passthrough: {
      upstreamBaseUrl: options.upstreamBaseUrl,
    },
  });

  try {
    await server.start();
  } catch (error) {
    if (options.interceptMode === "nftables") {
      removeNftablesRedirect(options);
    }
    throw error;
  }
  const addr = server.getAddress();
  process.stdout.write(
    `[telegram-api-mock-server] listening on ${addr?.host ?? options.host}:${addr?.port ?? options.port} mode=${server.getMode()}\n`,
  );
  const adminAddr = server.getAdminAddress();
  if (adminAddr) {
    process.stdout.write(`[telegram-api-mock-server] admin on http://${adminAddr.host}:${adminAddr.port}\n`);
  }
  process.stdout.write(`[telegram-api-mock-server] NODE_EXTRA_CA_CERTS=${tls.caPath}\n`);

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (options.interceptMode === "nftables") {
    refreshTimer = setInterval(() => {
      void applyNftablesRedirect(options).catch((error) => {
        process.stderr.write(`[telegram-api-mock-server] nft refresh failed: ${String(error)}\n`);
      });
    }, options.refreshSeconds * 1000);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    await server.stop();
    if (options.interceptMode === "nftables") {
      removeNftablesRedirect(options);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function run(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "mock") {
    const action = process.argv[3];
    if (action !== "on" && action !== "off") {
      throw new Error("mock command requires action 'on' or 'off'");
    }
    const options = parseArgs(process.argv.slice(4));
    await commandMock(options, action);
    return;
  }

  const options = parseArgs(process.argv.slice(3));

  if (command === "start") {
    await commandStart(options);
    return;
  }
  if (command === "bootstrap") {
    await commandBootstrap(options);
    return;
  }
  if (command === "install-service") {
    await commandInstallService(options);
    return;
  }
  if (command === "uninstall-service") {
    await commandUninstallService(options);
    return;
  }
  if (command === "status") {
    await commandStatus(options);
    return;
  }
  if (command === "logs") {
    await commandLogs(options);
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

run().catch((error) => {
  process.stderr.write(`[telegram-api-mock-server] ${String(error)}\n`);
  process.exit(1);
});
