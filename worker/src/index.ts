import { createLandingPage } from "../../src/site";
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "../../src/json";
import {
  CFSHARE_FORMAT,
  CFSHARE_UPLOAD_PROTOCOL,
  MAX_ENCRYPTED_SIZE,
  type CFShareManifest,
} from "../../src/types";
import { json, publicHeaders } from "./http";
import { parseUploadManifest } from "./protocol";
import { ShareObject } from "./share-object";

export { ShareObject };

const MAX_CREATE_BODY_BYTES = 1024 * 1024;

type JsonBodyResult = { ok: true; value: JsonValue } | { ok: false; error: string; status: number };

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("Content-Length");

  if (
    contentLength !== null &&
    (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_CREATE_BODY_BYTES)
  ) {
    return { ok: false, error: "Request body is too large", status: 413 };
  }

  if (!request.body) {
    return { ok: false, error: "Request body must be valid JSON", status: 400 };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > MAX_CREATE_BODY_BYTES) {
        await reader.cancel("Request body is too large").catch(() => {});
        return { ok: false, error: "Request body is too large", status: 413 };
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    const value: JsonValue = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, error: "Request body must be valid JSON", status: 400 };
  }
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function tokensMatch(expected: string, actual: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
  ]);

  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(actualHash);
  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

async function authorizeUpload(request: Request, env: Env): Promise<Response | null> {
  if (!env.UPLOAD_TOKEN) {
    return json({ error: "Uploads are disabled until UPLOAD_TOKEN is configured" }, 503);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!token || !(await tokensMatch(env.UPLOAD_TOKEN, token))) {
    return json({ error: "Invalid upload token" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  return null;
}

function instanceHome(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const defaultTtl = parseInteger(env.DEFAULT_TTL_SECONDS, 3600);
  const authState = env.UPLOAD_TOKEN ? "token required" : "uploads disabled";

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cfshare node</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11120f;color:#eeeadd;font:16px/1.6 ui-monospace,monospace}.box{width:min(720px,calc(100% - 40px));border-top:5px solid #d9ff43;padding-top:30px}h1{font:64px/1 Georgia,serif;margin:0 0 22px}.tag{color:#d9ff43;text-transform:uppercase;letter-spacing:.12em;font-size:12px}code{color:#d9ff43}hr{border:0;border-top:1px solid #42433b;margin:28px 0}</style></head><body><main class="box"><p class="tag">Self-hosted edge transfer</p><h1>cfshare node online.</h1><p>Point the CLI at this origin to create expiring, encrypted shares stored entirely inside one Durable Object.</p><p><code>cfshare file.zip --server ${url.origin} --ttl ${defaultTtl}s</code></p><hr><p>Upload policy: ${authState}<br>Storage: streamed Durable Object SQLite<br>Health: <a href="/health" style="color:inherit">/health</a></p></main></body></html>`,
    { headers: publicHeaders("text/html; charset=utf-8") },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return instanceHome(request, env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "cfshare",
        protocol: CFSHARE_UPLOAD_PROTOCOL,
        format: CFSHARE_FORMAT,
        metadata: "durable-objects",
        payloads: "durable-objects",
        streaming: true,
      });
    }

    if (url.pathname === "/api/shares" && request.method === "POST") {
      const denied = await authorizeUpload(request, env);

      if (denied) {
        return denied;
      }

      const bodyResult = await readJsonBody(request);

      if (!bodyResult.ok) {
        return json({ error: bodyResult.error }, bodyResult.status);
      }

      const body = bodyResult.value;

      if (!isJsonObject(body)) {
        return json({ error: "Request body must be a JSON object" }, 400);
      }

      if (body.protocol !== CFSHARE_UPLOAD_PROTOCOL) {
        return json(
          { error: "Unsupported upload protocol", supported: CFSHARE_UPLOAD_PROTOCOL },
          409,
        );
      }

      const defaultTtl = parseInteger(env.DEFAULT_TTL_SECONDS, 3600);
      const minTtl = parseInteger(env.MIN_TTL_SECONDS, 10);
      const maxTtl = parseInteger(env.MAX_TTL_SECONDS, 2592000);
      const maxUploadBytes = parseInteger(env.MAX_UPLOAD_BYTES, MAX_ENCRYPTED_SIZE);
      const ttl = body.ttl === undefined ? defaultTtl : body.ttl;

      if (!isJsonNumber(ttl) || !Number.isSafeInteger(ttl) || ttl < minTtl || ttl > maxTtl) {
        return json({ error: `TTL must be between ${minTtl} and ${maxTtl} seconds` }, 400);
      }

      const parsedManifest = parseUploadManifest(body.manifest ?? null, maxUploadBytes);

      if (!parsedManifest.ok) {
        return json({ error: parsedManifest.error }, 400);
      }

      const id = randomSlug();
      const expiresAt = Date.now() + ttl * 1000;
      const manifest = {
        ...parsedManifest.manifest,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      } satisfies CFShareManifest;

      const initialized = await env.SHARES.getByName(id).fetch("https://cfshare.internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest, expiresAt }),
      });

      if (!initialized.ok) {
        return initialized;
      }

      return json(
        {
          id,
          protocol: CFSHARE_UPLOAD_PROTOCOL,
          url: `${url.origin}/${id}/`,
          expiresAt: manifest.expiresAt,
        },
        201,
      );
    }

    const apiMatch = url.pathname.match(/^\/api\/shares\/([A-Za-z0-9_-]{20})(?:\/(.*))?$/);

    if (apiMatch) {
      const denied = await authorizeUpload(request, env);

      if (denied) {
        return denied;
      }

      const [, id, action = ""] = apiMatch;
      const stub = env.SHARES.getByName(id);

      const segmentMatch = action.match(/^payload\/(0|[1-9]\d*)$/);

      if (request.method === "PUT" && segmentMatch) {
        const segmentIndex = Number(segmentMatch[1]);

        if (!Number.isSafeInteger(segmentIndex)) {
          return json({ error: "Invalid payload segment" }, 400);
        }

        return stub.fetch(`https://cfshare.internal/segment/${segmentIndex}`, {
          method: "PUT",
          body: request.body,
        });
      }

      if (request.method === "POST" && action === "complete") {
        const completed = await stub.fetch("https://cfshare.internal/complete", { method: "POST" });

        if (!completed.ok) {
          return completed;
        }

        const result: JsonValue = await completed.json();

        if (!isJsonObject(result) || !isJsonString(result.expiresAt)) {
          return json({ error: "Invalid completion response" }, 502);
        }

        return json({ url: `${url.origin}/${id}/`, expiresAt: result.expiresAt });
      }

      if (request.method === "DELETE" && action === "") {
        return stub.fetch("https://cfshare.internal/", { method: "DELETE" });
      }

      return json({ error: "Not found" }, 404);
    }

    const publicMatch = url.pathname.match(/^\/([A-Za-z0-9_-]{20})(?:\/(.*))?$/);

    if (publicMatch) {
      const [, id, resource] = publicMatch;

      if (resource === undefined) {
        return Response.redirect(`${url.origin}/${id}/`, 308);
      }

      const stub = env.SHARES.getByName(id);

      if (!resource && request.method === "GET") {
        const manifestResponse = await stub.fetch("https://cfshare.internal/manifest", {
          method: "GET",
        });

        if (!manifestResponse.ok) {
          return manifestResponse;
        }

        return new Response(createLandingPage(), {
          headers: {
            ...publicHeaders("text/html; charset=utf-8"),
            "Content-Security-Policy":
              "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          },
        });
      }

      if (resource === "cfshare.json" && request.method === "GET") {
        return stub.fetch("https://cfshare.internal/manifest", { method: "GET" });
      }

      if (resource === "payload.bin" && request.method === "GET") {
        return stub.fetch("https://cfshare.internal/payload", { method: "GET" });
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
