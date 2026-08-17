import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDuration, uploadToSelfHosted } from "../src/self-hosted";
import { CFSHARE_FORMAT, CFSHARE_UPLOAD_PROTOCOL, type CFShareManifest } from "../src/types";
import { inputUrl } from "./helpers";

interface RecordedRequest {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body?: string;
}

function manifest(size: number): CFShareManifest {
  return {
    format: CFSHARE_FORMAT,
    name: "demo.txt",
    type: "text/plain",
    size: size - 16,
    storedSize: size,
    createdAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-08-08T01:00:00.000Z",
    payloads: [{ path: "payload-000.bin", size }],
    crypto: {
      algorithm: "AES-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: 600000,
      salt: Buffer.alloc(16).toString("base64url"),
      iv: Buffer.alloc(12).toString("base64url"),
    },
  };
}

test("parses human-friendly durations", () => {
  assert.equal(parseDuration("30s"), 30);
  assert.equal(parseDuration("15m"), 900);
  assert.equal(parseDuration("12h"), 43200);
  assert.equal(parseDuration("7d"), 604800);
  assert.throws(() => parseDuration("tomorrow"), /TTL must look like/);
});

test("streams a payload segment then completes a self-hosted share", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-upload-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const payload = "abcdefghijklmnopqrs";

  await writeFile(join(root, "payload-000.bin"), payload);

  const metadata = manifest(payload.length);
  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (url, init) => {
    let body: string | undefined;

    if (init?.method === "PUT") {
      body = Buffer.from(await new Response(init.body).arrayBuffer()).toString();
    } else if (init?.body !== undefined && init.body !== null) {
      body = await new Response(init.body).text();
    }

    requests.push({
      url: inputUrl(url),
      method: init?.method,
      authorization: new Headers(init?.headers).get("Authorization"),
      body,
    });

    if (inputUrl(url).endsWith("/api/shares")) {
      return Response.json(
        { id: "abcdefghijklmnopqrst", protocol: CFSHARE_UPLOAD_PROTOCOL },
        { status: 201 },
      );
    }

    if (inputUrl(url).endsWith("/complete")) {
      return Response.json({
        url: "https://share.example/abcdefghijklmnopqrst/",
        expiresAt: "2026-08-08T00:00:00.000Z",
      });
    }

    return Response.json({ ok: true });
  };

  const result = await uploadToSelfHosted({
    serverUrl: "https://share.example",
    assetsDir: root,
    metadata,
    ttlSeconds: 3600,
    token: "upload-secret",
    fetchImpl,
  });

  assert.equal(result.url, "https://share.example/abcdefghijklmnopqrst/");
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "PUT", "POST"],
  );
  assert.equal(requests[1].body, payload);
  const createRequest = requests[0];
  if (!createRequest?.body) {
    assert.fail("Expected a recorded create request body");
  }

  assert.equal(JSON.parse(createRequest.body).protocol, CFSHARE_UPLOAD_PROTOCOL);
  assert.ok(requests.every(({ authorization }) => authorization === "Bearer upload-secret"));
});

test("rejects an incompatible server before uploading", async () => {
  const methods: Array<string | undefined> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    methods.push(init?.method);

    return init?.method === "POST"
      ? Response.json({ id: "abcdefghijklmnopqrst" }, { status: 201 })
      : Response.json({ ok: true });
  };

  await assert.rejects(
    uploadToSelfHosted({
      serverUrl: "https://share.example",
      assetsDir: ".",
      metadata: manifest(19),
      fetchImpl,
    }),
    /unsupported upload protocol/,
  );
  assert.deepEqual(methods, ["POST", "DELETE"]);
});

test("reports cleanup failures after a partial upload", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-cleanup-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const payload = "abcdefghijklmnopqrs";

  await writeFile(join(root, "payload-000.bin"), payload);

  const metadata = manifest(payload.length);

  const fetchImpl: typeof fetch = async (url, init) => {
    if (inputUrl(url).endsWith("/api/shares")) {
      return Response.json(
        { id: "abcdefghijklmnopqrst", protocol: CFSHARE_UPLOAD_PROTOCOL },
        { status: 201 },
      );
    }

    if (init?.method === "DELETE") {
      return Response.json({ error: "token rotated" }, { status: 401 });
    }

    return Response.json({ error: "storage unavailable" }, { status: 500 });
  };

  await assert.rejects(
    uploadToSelfHosted({
      serverUrl: "https://share.example",
      assetsDir: root,
      metadata,
      fetchImpl,
      retryDelays: [],
    }),
    /Payload segment 1 failed: storage unavailable; cleanup failed: token rotated/,
  );
});

test("retries an idempotent payload segment", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-retry-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const payload = "abcdefghijklmnopqrs";

  await writeFile(join(root, "payload-000.bin"), payload);

  const metadata = manifest(payload.length);
  let putAttempts = 0;

  const fetchImpl: typeof fetch = async (url, init) => {
    if (inputUrl(url).endsWith("/api/shares")) {
      return Response.json(
        { id: "abcdefghijklmnopqrst", protocol: CFSHARE_UPLOAD_PROTOCOL },
        { status: 201 },
      );
    }

    if (init?.method === "PUT" && ++putAttempts === 1) {
      return Response.json({ error: "temporarily busy" }, { status: 503 });
    }

    if (inputUrl(url).endsWith("/complete")) {
      return Response.json({
        url: "https://share.example/abcdefghijklmnopqrst/",
        expiresAt: "2026-08-08T00:00:00.000Z",
      });
    }

    return Response.json({ ok: true });
  };

  await uploadToSelfHosted({
    serverUrl: "https://share.example",
    assetsDir: root,
    metadata,
    fetchImpl,
    retryDelays: [0],
  });

  assert.equal(putAttempts, 2);
});

test("rejects completion details from another origin", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-completion-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "payload-000.bin"), "abcdefghijklmnopqrs");

  const fetchImpl: typeof fetch = async (url, init) => {
    if (inputUrl(url).endsWith("/api/shares")) {
      return Response.json(
        { id: "abcdefghijklmnopqrst", protocol: CFSHARE_UPLOAD_PROTOCOL },
        { status: 201 },
      );
    }

    if (inputUrl(url).endsWith("/complete")) {
      return Response.json({
        url: "https://attacker.example/abcdefghijklmnopqrst/",
        expiresAt: "2026-08-17T01:00:00.000Z",
      });
    }

    return Response.json({ ok: true, method: init?.method });
  };

  await assert.rejects(
    uploadToSelfHosted({
      serverUrl: "https://share.example",
      assetsDir: root,
      metadata: manifest(19),
      fetchImpl,
      retryDelays: [],
    }),
    /inconsistent share details/,
  );
});
