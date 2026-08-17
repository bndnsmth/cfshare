import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  CFSHARE_UPLOAD_PROTOCOL,
  type CFShareManifest,
  type SelfHostedUploadResult,
} from "./types";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json";

export const SELF_HOSTED_CHUNK_SIZE = 50 * 1024 * 1024;

interface UploadToSelfHostedOptions {
  serverUrl: string;
  assetsDir: string;
  metadata: CFShareManifest;
  ttlSeconds?: number;
  token?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (uploaded: number, total: number) => void;
  retryDelays?: number[];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function headers(token?: string, extra: HeadersInit = {}): Headers {
  const result = new Headers(extra);

  if (token) {
    result.set("Authorization", `Bearer ${token}`);
  }

  return result;
}

function isErrorResponse(value: JsonValue): value is { error: string } {
  return isJsonObject(value) && isJsonString(value.error);
}

function isCreateResponse(value: JsonValue): value is JsonObject & { id: string } {
  return isJsonObject(value) && isJsonString(value.id) && /^[A-Za-z0-9_-]{20}$/.test(value.id);
}

function isCompletionResponse(value: JsonValue): value is JsonObject & SelfHostedUploadResult {
  return isJsonObject(value) && isJsonString(value.url) && isJsonString(value.expiresAt);
}

async function readError(response: Response): Promise<string> {
  try {
    const body: JsonValue = await response.json();
    return isErrorResponse(body) ? body.error : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function requestWithRetry(
  makeRequest: () => Promise<Response>,
  label: string,
  retryDelays: number[],
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    let response: Response | undefined;

    try {
      response = await makeRequest();
    } catch (cause) {
      lastError = cause instanceof Error ? cause : new Error(String(cause));
    }

    if (response?.ok) {
      return response;
    }

    if (response) {
      const error = new Error(`${label}: ${await readError(response)}`);

      if (response.status !== 408 && response.status !== 429 && response.status < 500) {
        throw error;
      }

      lastError = error;
    }

    if (attempt < retryDelays.length) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelays[attempt]));
    }
  }

  throw lastError ?? new Error(`${label}: request failed`);
}

export function parseDuration(value: string | number | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }

  const match = String(value)
    .trim()
    .match(/^(\d+)(s|m|h|d)?$/i);

  if (!match) {
    throw new Error("TTL must look like 30s, 15m, 2h, or 7d");
  }

  const amount = Number(match[1]);
  const suffix = (match[2] ?? "s").toLowerCase();
  const factor = suffix === "d" ? 86400 : suffix === "h" ? 3600 : suffix === "m" ? 60 : 1;
  const seconds = amount * factor;

  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("TTL must be greater than zero");
  }

  return seconds;
}

export async function uploadToSelfHosted({
  serverUrl,
  assetsDir,
  metadata,
  ttlSeconds,
  token,
  fetchImpl = fetch,
  onProgress,
  retryDelays = [200, 500],
}: UploadToSelfHostedOptions): Promise<SelfHostedUploadResult> {
  const baseUrl = new URL(serverUrl);
  const createBody = {
    protocol: CFSHARE_UPLOAD_PROTOCOL,
    manifest: metadata,
    ttl: ttlSeconds,
  };
  const createResponse = await fetchImpl(new URL("api/shares", baseUrl), {
    method: "POST",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(createBody),
  });

  if (!createResponse.ok) {
    throw new Error(`Self-hosted create failed: ${await readError(createResponse)}`);
  }

  const createdJson: JsonValue = await createResponse.json();

  if (!isCreateResponse(createdJson)) {
    throw new Error("Self-hosted server returned an invalid create response");
  }

  const created = createdJson;

  let uploaded = 0;
  try {
    if (created.protocol !== CFSHARE_UPLOAD_PROTOCOL) {
      throw new Error("Self-hosted server uses an unsupported upload protocol");
    }

    for (let index = 0; index < metadata.payloads.length; index += 1) {
      const payload = metadata.payloads[index];

      await requestWithRetry(
        () => {
          const body = Readable.toWeb(createReadStream(join(assetsDir, payload.path)));
          // SAFETY: Node fetch accepts the web stream returned by Readable.toWeb at runtime.
          const requestBody = body as BodyInit;
          const init: RequestInit & { duplex: "half" } = {
            method: "PUT",
            headers: headers(token, {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(payload.size),
            }),
            body: requestBody,
            duplex: "half",
          };
          return fetchImpl(new URL(`api/shares/${created.id}/payload/${index}`, baseUrl), init);
        },
        `Payload segment ${index + 1} failed`,
        retryDelays,
      );

      uploaded += payload.size;
      onProgress?.(uploaded, metadata.storedSize);
    }

    const completeResponse = await requestWithRetry(
      () =>
        fetchImpl(new URL(`api/shares/${created.id}/complete`, baseUrl), {
          method: "POST",
          headers: headers(token),
        }),
      "Self-hosted completion failed",
      retryDelays,
    );

    const completedJson: JsonValue = await completeResponse.json();

    if (!isCompletionResponse(completedJson)) {
      throw new Error("Self-hosted server returned an invalid completion response");
    }

    const completedUrl = new URL(completedJson.url);
    if (
      completedUrl.origin !== baseUrl.origin ||
      completedUrl.pathname !== `/${created.id}/` ||
      !Number.isFinite(Date.parse(completedJson.expiresAt))
    ) {
      throw new Error("Self-hosted server returned inconsistent share details");
    }

    return { url: completedUrl.href, expiresAt: completedJson.expiresAt };
  } catch (error) {
    let cleanupError;

    try {
      const cleanupResponse = await fetchImpl(new URL(`api/shares/${created.id}`, baseUrl), {
        method: "DELETE",
        headers: headers(token),
      });

      if (!cleanupResponse.ok) {
        cleanupError = await readError(cleanupResponse);
      }
    } catch (failure) {
      cleanupError = errorMessage(failure);
    }

    const message = errorMessage(error);

    throw new Error(cleanupError ? `${message}; cleanup failed: ${cleanupError}` : message, {
      cause: error,
    });
  }
}
