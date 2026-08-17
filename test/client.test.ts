import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CFSHARE_FORMAT, CFSHARE_UPLOAD_PROTOCOL, createClient, CFShareClient } from "../src/index";
import { decryptBuffer, encryptBuffer } from "../src/crypto";
import { isJsonObject, type JsonValue } from "../src/json";
import { parseManifest } from "../src/manifest";
import type { CFShareProgress, CryptoMetadata } from "../src/types";
import { inputUrl } from "./helpers";

interface RecordedRequest {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body?: Buffer | string;
}

function isStringBody(value: RecordedRequest["body"]): value is string {
  return typeof value === "string";
}

function isBufferBody(value: RecordedRequest["body"]): value is Buffer {
  return Buffer.isBuffer(value);
}

test("exports a configurable client", () => {
  const client = createClient({ server: "https://share.example/", token: "secret" });

  assert.ok(client instanceof CFShareClient);
  assert.equal(client.server, "https://share.example");
  assert.equal(client.backend, "self-hosted");
  assert.equal(client.token, "secret");
});

test("client shares through the self-hosted protocol", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-client-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "demo.txt");

  await writeFile(sourcePath, "library upload");

  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (url, init) => {
    let body: RecordedRequest["body"];

    if (init?.method === "PUT") {
      body = Buffer.from(await new Response(init.body).arrayBuffer());
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
        expiresAt: "2026-08-09T00:00:00.000Z",
      });
    }

    return Response.json({ ok: true });
  };

  const progress: CFShareProgress[] = [];
  const client = createClient({
    server: "https://share.example",
    token: "upload-token",
    fetch: fetchImpl,
  });

  const result = await client.share(sourcePath, {
    ttl: "12h",
    retryDelays: [],
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.url, "https://share.example/abcdefghijklmnopqrst/");
  assert.equal(result.backend, "self-hosted");
  assert.equal(result.name, "demo.txt");
  assert.match(
    result.generatedPassphrase ?? "",
    /^(?:[bcdfghjkmnprstvw][aeio]){3}(?:-(?:[bcdfghjkmnprstvw][aeio]){3}){5}$/,
  );
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "PUT", "POST"],
  );
  const createRequest = requests[0];
  const payloadRequest = requests[1];

  if (!createRequest || !isStringBody(createRequest.body)) {
    assert.fail("Expected a recorded create request body");
  }

  if (!payloadRequest || !isBufferBody(payloadRequest.body)) {
    assert.fail("Expected a recorded payload request body");
  }

  const createBody = JSON.parse(createRequest.body);
  const payload = payloadRequest.body;

  assert.equal(createBody.manifest.crypto.algorithm, "AES-GCM");
  assert.notDeepEqual(payload, Buffer.from("library upload"));
  assert.deepEqual(
    await decryptBuffer(payload, result.generatedPassphrase ?? "", createBody.manifest.crypto),
    Buffer.from("library upload"),
  );
  assert.ok(requests.every(({ authorization }) => authorization === "Bearer upload-token"));
  assert.deepEqual(
    progress.map(({ phase }) => phase),
    ["preparing", "prepared", "uploading", "uploading", "complete"],
  );
  assert.ok(progress.every((event) => !("generatedPassphrase" in event)));
});

test("client requires explicit terms acceptance for Drop", async () => {
  const client = createClient();

  await assert.rejects(client.share("not-read.txt"), /acceptCloudflareTerms: true/);
});

test("client does not return a caller-provided passphrase", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-client-phrase-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "demo.txt");

  await writeFile(sourcePath, "secret");

  let payload: Buffer | undefined;
  let crypto: CryptoMetadata | undefined;

  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === "PUT") {
      payload = Buffer.from(await new Response(init.body).arrayBuffer());
    }

    if (inputUrl(url).endsWith("/api/shares")) {
      const body: JsonValue = await new Response(init?.body).json();
      const parsed = parseManifest(isJsonObject(body) ? (body.manifest ?? null) : null);

      if (!parsed.ok) {
        throw new Error(parsed.error);
      }

      crypto = parsed.manifest.crypto;

      return Response.json(
        { id: "abcdefghijklmnopqrst", protocol: CFSHARE_UPLOAD_PROTOCOL },
        { status: 201 },
      );
    }

    if (inputUrl(url).endsWith("/complete")) {
      return Response.json({
        url: "https://share.example/abcdefghijklmnopqrst/",
        expiresAt: "2026-08-09T00:00:00.000Z",
      });
    }

    return Response.json({ ok: true });
  };

  const result = await createClient({
    server: "https://share.example",
    token: "upload-token",
    fetch: fetchImpl,
  }).share(sourcePath, { passphrase: "my own phrase" });

  assert.equal(result.generatedPassphrase, null);
  assert.ok(payload && crypto);
  assert.deepEqual(await decryptBuffer(payload, "my own phrase", crypto), Buffer.from("secret"));
});

test("client downloads a cfshare transfer into memory", async () => {
  const data = Buffer.from("downloaded through client");
  const encrypted = await encryptBuffer(data, "download phrase");
  const manifest = {
    format: CFSHARE_FORMAT,
    name: "download.txt",
    type: "text/plain",
    size: data.length,
    storedSize: encrypted.data.length,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    payloads: [{ path: "payload.bin", size: encrypted.data.length }],
    crypto: encrypted.crypto,
  };

  const fetchImpl: typeof fetch = async (url) =>
    inputUrl(url).endsWith("cfshare.json")
      ? Response.json(manifest)
      : new Response(new Uint8Array(encrypted.data));

  const client = createClient({ fetch: fetchImpl });

  const result = await client.download("https://share.example/abcdefghijklmnopqrst/", {
    passphrase: "download phrase",
  });

  assert.equal(result.manifest.name, "download.txt");
  assert.deepEqual(result.data, data);
});
