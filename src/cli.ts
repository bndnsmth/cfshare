import { createInterface } from "node:readline/promises";
import packageMetadata from "../package.json" with { type: "json" };
import { CONFIG_PATH, normalizeServerUrl, readConfig, writeConfig } from "./config";
import { createClient } from "./client";

const VERSION = packageMetadata.version;
const TERMS_URL = "https://www.cloudflare.com/terms/";
const PRIVACY_URL = "https://www.cloudflare.com/privacypolicy/";

type Command = "help" | "version" | "config" | "send" | "get";

export interface CLIOptions {
  command: Command;
  action?: "show" | "unset-server" | "set-server";
  value?: string;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  password?: string | true;
  server?: string;
  ttl?: string;
  token?: string;
  output?: string;
  target?: string;
}

const HELP = `cfshare - expiring file transfers on Cloudflare

Usage:
  cfshare <path> [options]
  cfshare send <path> [options]
  cfshare get <url> [options]
  cfshare config set server <url|drop>
  cfshare config unset server
  cfshare config show

Send options:
  -p, --password[=phrase]  Use your own phrase; omit the value to prompt
                           Omit this option to generate a secure phrase
  -y, --yes                Accept Cloudflare Terms and Privacy Policy
      --json               Print machine-readable output
      --server <url|drop>  Override the configured upload backend
      --ttl <duration>     Self-hosted expiry, such as 30m, 12h, or 7d
      --token <token>      Self-hosted token (prefer CFSHARE_TOKEN)

Get options:
  -p, --password[=phrase]  Decryption phrase; omit the value to prompt
  -o, --output <path>      Download destination
  -f, --force              Replace an existing destination

Environment:
  CFSHARE_PASSWORD         Passphrase for non-interactive use
  CFSHARE_SERVER           Self-hosted origin; unset to use Cloudflare Drop
  CFSHARE_TOKEN            Self-hosted upload bearer token

Examples:
  cfshare ./demo.zip
  cfshare ./photos --yes
  cfshare ./notes.pdf --yes
  cfshare ./build.zip --server https://share.example.com --ttl 12h
  cfshare get https://example.workers.dev --password -o notes.pdf
`;

export function parseArgs(argv: string[]): CLIOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help" };
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    return { command: "version" };
  }

  const args = [...argv];

  if (args[0] === "config") {
    const configArgs = args.slice(1);

    if (configArgs.length === 1 && configArgs[0] === "show") {
      return { command: "config", action: "show" };
    }

    if (configArgs.length === 2 && configArgs[0] === "unset" && configArgs[1] === "server") {
      return { command: "config", action: "unset-server" };
    }

    if (configArgs.length === 3 && configArgs[0] === "set" && configArgs[1] === "server") {
      return { command: "config", action: "set-server", value: configArgs[2] };
    }

    throw new Error("Use 'cfshare config set server <url|drop>', 'unset server', or 'show'");
  }

  let command: "send" | "get" = "send";

  if (args[0] === "send" || args[0] === "get") {
    command = args.shift() === "get" ? "get" : "send";
  }

  const options: CLIOptions = { command, yes: false, json: false, force: false };
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--password" || arg === "-p") {
      options.password = true;
    } else if (arg.startsWith("--password=")) {
      options.password = arg.slice("--password=".length);
    } else if (arg === "--server") {
      if (!args[index + 1]) {
        throw new Error("--server requires a URL or 'drop'");
      }

      options.server = args[++index];
    } else if (arg.startsWith("--server=")) {
      options.server = arg.slice("--server=".length);
    } else if (arg === "--ttl") {
      if (!args[index + 1]) {
        throw new Error("--ttl requires a duration");
      }

      options.ttl = args[++index];
    } else if (arg.startsWith("--ttl=")) {
      options.ttl = arg.slice("--ttl=".length);
    } else if (arg === "--token") {
      if (!args[index + 1]) {
        throw new Error("--token requires a value");
      }

      options.token = args[++index];
    } else if (arg.startsWith("--token=")) {
      options.token = arg.slice("--token=".length);
    } else if (arg === "--output" || arg === "-o") {
      if (!args[index + 1]) {
        throw new Error(`${arg} requires a path`);
      }

      options.output = args[++index];
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) {
    throw new Error(`${command} requires exactly one ${command === "get" ? "URL" : "path"}`);
  }

  options.target = positionals[0];

  if (command === "send" && (options.force || options.output)) {
    throw new Error("--force and --output are only valid with 'cfshare get'");
  }

  if (
    command === "get" &&
    (options.yes || options.json || options.server || options.ttl || options.token)
  ) {
    throw new Error("--yes, --json, --server, --ttl, and --token are only valid when sending");
  }

  return options;
}

async function confirmCloudflareTerms(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Use --yes in non-interactive mode to accept Cloudflare's Terms and Privacy Policy",
    );
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `Temporary deployment requires accepting:\n  ${TERMS_URL}\n  ${PRIVACY_URL}\nContinue? [y/N] `,
  );

  prompt.close();

  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new Error("Cancelled");
  }
}

export async function promptHidden(label = "Passphrase: "): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Set CFSHARE_PASSWORD for passphrase use in non-interactive mode");
  }

  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");

      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(value);
      }
    };

    const onEnd = () => finish(new Error("Input ended before a passphrase was entered"));
    const onError = (cause: Error) => finish(cause);
    const onData = (data: string) => {
      for (const character of data) {
        if (character === "\u0003") {
          finish(new Error("Cancelled"));
          return;
        }

        if (character === "\r" || character === "\n") {
          finish();
          return;
        }

        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (character >= " ") {
          value += character;
          process.stdout.write("*");
        }
      }
    };

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

async function resolvePassphrase(option: string | true | undefined): Promise<string | undefined> {
  if (option !== undefined && option !== true) {
    return option;
  }

  if (process.env.CFSHARE_PASSWORD) {
    return process.env.CFSHARE_PASSWORD;
  }

  if (option === true) {
    return promptHidden();
  }

  return undefined;
}

async function send(options: CLIOptions): Promise<void> {
  if (!options.target) {
    throw new Error("send requires a path");
  }

  const config = await readConfig();
  const configuredServer = options.server ?? process.env.CFSHARE_SERVER ?? config.server ?? "drop";
  const client = createClient({
    server: configuredServer,
    token: options.token ?? process.env.CFSHARE_TOKEN,
  });
  const selfHosted = client.backend === "self-hosted";

  if (!selfHosted && options.ttl) {
    throw new Error(
      "Cloudflare Drop shares always expire in one hour; use --server for a custom TTL",
    );
  }

  if (!selfHosted && !options.yes) {
    await confirmCloudflareTerms();
  }

  const passphrase = await resolvePassphrase(options.password);

  const result = await client.share(options.target, {
    passphrase,
    ttl: options.ttl,
    acceptCloudflareTerms: !selfHosted,
    onProgress: (progress) => {
      if (options.json) {
        return;
      }

      if (progress.phase === "prepared" && progress.metadata) {
        const metadata = progress.metadata;
        console.error(`Encrypting ${metadata.name} (${metadata.size.toLocaleString()} bytes)`);
        console.error(
          selfHosted
            ? `Uploading to ${client.server}...\n`
            : "Deploying an isolated one-hour site through Cloudflare...\n",
        );
      } else if (
        progress.phase === "uploading" &&
        process.stderr.isTTY &&
        progress.total &&
        progress.loaded != null
      ) {
        process.stderr.write(
          `\rUploading ${Math.round((progress.loaded / progress.total) * 100)}%`,
        );
      }
    },
  });

  if (!options.json && process.stderr.isTTY) {
    process.stderr.write("\r\x1b[2K");
  }

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`\n🔗 Share URL:  ${result.url}`);

    if (result.generatedPassphrase) {
      console.log(`🔑 Passphrase: ${result.generatedPassphrase}\n   Send this separately.`);
    }

    console.log("");
    console.log(`Expires:    ${result.expiresAt}`);
    console.log(`Backend:    ${result.backend}`);
    console.log("Protection: AES-256-GCM");

    if (result.claimUrl) {
      console.log(
        `Claim URL:  ${result.claimUrl}\n             Treat this as a private ownership link.`,
      );
    }
  }
}

async function configure(options: CLIOptions): Promise<void> {
  const config = await readConfig();
  if (options.action === "show") {
    console.log(JSON.stringify({ path: CONFIG_PATH, server: config.server ?? "drop" }, null, 2));
    return;
  }

  if (options.action !== "unset-server" && !options.value) {
    throw new Error("config set server requires a URL or 'drop'");
  }

  const server =
    options.action === "unset-server" ? "drop" : normalizeServerUrl(options.value ?? "drop");

  if (server === "drop") {
    delete config.server;
  } else {
    config.server = server;
  }

  await writeConfig(config);

  console.log(config.server ?? "drop");
}

async function get(options: CLIOptions): Promise<void> {
  if (!options.target) {
    throw new Error("get requires a URL");
  }

  const client = createClient();
  const passphrase = await resolvePassphrase(options.password ?? true);
  let transfer;

  try {
    transfer = await client.downloadToFile(options.target, {
      passphrase,
      output: options.output,
      force: options.force,
      onProgress: (progress) => {
        if (
          progress.phase === "receiving" &&
          process.stderr.isTTY &&
          progress.total &&
          progress.loaded != null
        ) {
          process.stderr.write(
            `\rReceiving ${Math.round((progress.loaded / progress.total) * 100)}%`,
          );
        }
      },
    });
  } finally {
    if (process.stderr.isTTY) {
      process.stderr.write("\r\x1b[2K");
    }
  }

  console.log(transfer.path);
}

export async function run(argv: string[]): Promise<void> {
  const options = parseArgs(argv);

  if (options.command === "help") {
    return console.log(HELP);
  }

  if (options.command === "version") {
    return console.log(VERSION);
  }

  if (options.command === "config") {
    return configure(options);
  }

  if (options.command === "send") {
    return send(options);
  }

  return get(options);
}
