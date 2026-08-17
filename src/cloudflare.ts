import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const DEPLOY_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DEPLOY_OUTPUT_BYTES = 1024 * 1024;

export interface TemporaryDeployment {
  previewUrl: string;
  claimUrl?: string;
}

function stripAnsi(value: string): string {
  // oxlint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseDeploymentOutput(output: string): TemporaryDeployment {
  const clean = stripAnsi(output);
  const previewMatches = [...clean.matchAll(/https:\/\/[^\s]+\.workers\.dev\/?/g)];
  const claimMatch = clean.match(/https:\/\/dash\.cloudflare\.com\/claim-preview\?[^\s]+/);
  const previewUrl = previewMatches.at(-1)?.[0]?.replace(/[),.;]+$/, "");
  const claimUrl = claimMatch?.[0]?.replace(/[),.;]+$/, "");

  if (!previewUrl) {
    throw new Error("Wrangler completed without returning a workers.dev URL");
  }

  return { previewUrl, claimUrl };
}

export async function deployTemporarySite(assetsDir: string): Promise<TemporaryDeployment> {
  const wranglerCli = require.resolve("wrangler");
  const isolatedHome = join(homedir(), ".cfshare", "wrangler");
  const workerName = `cfshare-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const compatibilityDate = new Date().toISOString().slice(0, 10);

  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, "config"),
    XDG_DATA_HOME: join(isolatedHome, "data"),
    XDG_CACHE_HOME: join(isolatedHome, "cache"),
    WRANGLER_HOME: isolatedHome,
    WRANGLER_SEND_METRICS: "false",
  };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_ACCOUNT_ID",
  ]) {
    delete env[key];
  }

  const args = [
    wranglerCli,
    "deploy",
    assetsDir,
    "--name",
    workerName,
    "--compatibility-date",
    compatibilityDate,
    "--temporary",
  ];

  return new Promise<TemporaryDeployment>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: assetsDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      reject(
        new Error(`Cloudflare deployment timed out after ${DEPLOY_TIMEOUT_MS / 1000} seconds`),
      );
    }, DEPLOY_TIMEOUT_MS);

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (forceKill) {
        clearTimeout(forceKill);
      }
      callback();
    };

    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_DEPLOY_OUTPUT_BYTES);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (cause) => finish(() => reject(cause)));
    child.on("close", (code) => {
      if (forceKill) {
        clearTimeout(forceKill);
      }

      if (code !== 0) {
        process.stderr.write(output);
        finish(() => reject(new Error(`Cloudflare deployment failed (Wrangler exit ${code})`)));
        return;
      }

      try {
        const result = parseDeploymentOutput(output);
        finish(() => resolve(result));
      } catch (cause) {
        finish(() => reject(cause));
      }
    });
  });
}
