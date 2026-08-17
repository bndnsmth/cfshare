import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isJsonObject, isJsonString, type JsonValue } from "./json";

export const CONFIG_PATH = join(homedir(), ".cfshare", "config.json");

export interface CFShareConfig {
  server?: string;
}

function isCFShareConfig(value: JsonValue): value is { server?: string } {
  return isJsonObject(value) && (value.server === undefined || isJsonString(value.server));
}

export function normalizeServerUrl(value: string): string {
  if (value === "drop") {
    return "drop";
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Server must be an absolute URL or 'drop'");
  }

  if (url.username || url.password) {
    throw new Error("Server URL must not contain credentials");
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Self-hosted server URLs must use HTTPS");
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Server URL must be an origin without a path, query, or fragment");
  }

  return url.origin;
}

export async function readConfig(path = CONFIG_PATH): Promise<CFShareConfig> {
  try {
    const config: JsonValue = JSON.parse(await readFile(path, "utf8"));

    return isCFShareConfig(config) ? { server: config.server } : {};
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}`);
    }

    throw error;
  }
}

export async function writeConfig(config: CFShareConfig, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw cause;
  }
}
