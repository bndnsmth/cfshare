import { createLandingPage } from "../../src/site";
import {
  CFSHARE_PROJECT_URL,
  createContentSecurityPolicy,
  escapeHtml,
  normalizeSiteBranding,
  type SiteBranding,
} from "../../src/branding";
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

function brandingFromEnv(env: Env): SiteBranding {
  return normalizeSiteBranding({
    name: env.BRAND_NAME,
    summary: env.BRAND_SUMMARY,
    logoUrl: env.BRAND_LOGO_URL,
    background: env.BRAND_BACKGROUND,
    foreground: env.BRAND_FOREGROUND,
    accent: env.BRAND_ACCENT,
  });
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
  const branding = brandingFromEnv(env);
  const brandName = escapeHtml(branding.name);
  const logo = branding.logoUrl ? `<img src="${escapeHtml(branding.logoUrl)}" alt="">` : "";
  const summary = branding.summary ? `<p class="summary">${escapeHtml(branding.summary)}</p>` : "";

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${brandName} node</title>
  <style>
    :root{--background:${branding.background};--foreground:${branding.foreground};--accent:${branding.accent};--muted:color-mix(in srgb,var(--foreground) 65%,var(--background));--line:color-mix(in srgb,var(--foreground) 24%,var(--background))}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--background);color:var(--foreground);font:16px/1.6 ui-monospace,monospace}.box{width:min(720px,calc(100% - 40px));border-top:5px solid var(--accent);padding-top:30px}.brand{display:flex;align-items:center;gap:12px;color:var(--accent);text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:800}.brand img{display:block;width:auto;height:34px;max-width:140px;object-fit:contain}.brand span,h1{overflow-wrap:anywhere}h1{font:64px/1 Georgia,serif;margin:24px 0 22px}.summary{max-width:620px;color:var(--accent);font-weight:700}.detail{color:var(--muted)}code{color:var(--accent)}hr{border:0;border-top:1px solid var(--line);margin:28px 0}.project-link{color:var(--muted);font-size:12px;text-underline-offset:3px}.project-link:hover{color:var(--accent)}@media(max-width:600px){h1{font-size:46px}}
  </style>
</head>
<body>
  <main class="box">
    <div class="brand">${logo}<span>${brandName} // Self-hosted edge transfer</span></div>
    <h1>${brandName} node online.</h1>
    ${summary}
    <p class="detail">Point the cfshare CLI at this origin to create expiring, encrypted shares stored entirely inside one Durable Object.</p>
    <p><code>cfshare file.zip --server ${url.origin} --ttl ${defaultTtl}s</code></p>
    <hr>
    <p>Upload policy: ${authState}<br>Storage: streamed Durable Object SQLite<br>Health: <a href="/health" style="color:inherit">/health</a></p>
    <a class="project-link" href="${CFSHARE_PROJECT_URL}" target="_blank" rel="noreferrer">Powered by cfshare</a>
  </main>
</body>
</html>`,
    {
      headers: {
        ...publicHeaders("text/html; charset=utf-8"),
        "Content-Security-Policy": createContentSecurityPolicy(branding),
      },
    },
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

        const branding = brandingFromEnv(env);

        return new Response(createLandingPage(branding), {
          headers: {
            ...publicHeaders("text/html; charset=utf-8"),
            "Content-Security-Policy": createContentSecurityPolicy(branding),
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
