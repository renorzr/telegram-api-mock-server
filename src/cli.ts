#!/usr/bin/env node
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { TelegramApiMockServer, type TelegramApiMockMode } from "./telegram-api-mock-server.js";

type CliOptions = {
  host: string;
  port: number;
  mode: TelegramApiMockMode;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  enableHostsHijack: boolean;
  hostsFilePath: string;
  adminToken?: string;
  upstreamBaseUrl?: string;
  noSudoReexec: boolean;
};

function printHelp(): void {
  process.stdout.write(
    [
      "telegram-api-mock-server",
      "",
      "Usage:",
      "  telegram-api-mock-server start [options]",
      "",
      "Options:",
      "  --host <host>                    Bind host (default: 127.0.0.1)",
      "  --port <port>                    Bind port (default: 19090)",
      "  --mode <mock|passthrough>        Initial mode (default: mock)",
      "  --admin-token <token>            Token required for /_admin/* endpoints",
      "  --enable-hosts-hijack            Add hosts entry for api.telegram.org",
      "  --hosts-file <path>              Hosts file path (default: /etc/hosts)",
      "  --tls-cert <path>                TLS cert path",
      "  --tls-key <path>                 TLS key path",
      "  --upstream-base-url <url>        Passthrough upstream URL",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: "127.0.0.1",
    port: 19090,
    mode: "mock",
    enableHostsHijack: false,
    hostsFilePath: "/etc/hosts",
    noSudoReexec: false,
  };

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
    if (arg === "--enable-hosts-hijack") {
      options.enableHostsHijack = true;
      continue;
    }
    if (arg === "--hosts-file" && next) {
      options.hostsFilePath = next;
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
    if (arg === "--no-sudo-reexec") {
      options.noSudoReexec = true;
      continue;
    }
    throw new Error(`Unknown or invalid argument: ${arg}`);
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive number");
  }
  if ((options.tlsCertPath && !options.tlsKeyPath) || (!options.tlsCertPath && options.tlsKeyPath)) {
    throw new Error("--tls-cert and --tls-key must be provided together");
  }

  return options;
}

function ensureSudoIfNeeded(options: CliOptions): void {
  if (!options.enableHostsHijack || options.noSudoReexec) {
    return;
  }
  try {
    accessSync(options.hostsFilePath, constants.W_OK);
    return;
  } catch {
    if (process.getuid && process.getuid() === 0) {
      return;
    }
  }

  const scriptPath = new URL(import.meta.url).pathname;
  const nextArgs = process.argv.slice(2).concat("--no-sudo-reexec");
  const result = spawnSync("sudo", [process.execPath, scriptPath, ...nextArgs], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

async function run(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command !== "start") {
    throw new Error(`Unsupported command: ${command}`);
  }

  const options = parseArgs(process.argv.slice(3));
  ensureSudoIfNeeded(options);

  const server = new TelegramApiMockServer({
    host: options.host,
    port: options.port,
    mode: options.mode,
    admin: {
      token: options.adminToken,
    },
    tls: options.tlsCertPath && options.tlsKeyPath ? { certPath: options.tlsCertPath, keyPath: options.tlsKeyPath } : undefined,
    interception: {
      enableHostsHijack: options.enableHostsHijack,
      hostsFilePath: options.hostsFilePath,
      domain: "api.telegram.org",
      ip: "127.0.0.1",
    },
    passthrough: {
      upstreamBaseUrl: options.upstreamBaseUrl,
    },
  });

  await server.start();
  const addr = server.getAddress();
  process.stdout.write(
    `[telegram-api-mock-server] listening on ${addr?.host ?? options.host}:${addr?.port ?? options.port} mode=${server.getMode()}\n`,
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

run().catch((error) => {
  process.stderr.write(`[telegram-api-mock-server] ${String(error)}\n`);
  process.exit(1);
});
