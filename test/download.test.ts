import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { encryptBuffer } from "../src/crypto";
import { fetchShare } from "../src/download";
import { CFSHARE_FORMAT } from "../src/types";
import { inputUrl } from "./helpers";

test("CLI downloader consumes the same encrypted manifest as the browser", async () => {
  const source = Buffer.from("shared bytes");
  const encrypted = await encryptBuffer(source, "open sesame");
  const manifest = {
    format: CFSHARE_FORMAT,
    name: "shared.txt",
    type: "text/plain",
    size: source.length,
    storedSize: encrypted.data.length,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    payloads: [{ path: "payload-000.bin", size: encrypted.data.length }],
    crypto: encrypted.crypto,
  };
  const responses = new Map([
    ["https://share.example/cfshare.json", new Response(JSON.stringify(manifest))],
    ["https://share.example/payload-000.bin", new Response(new Uint8Array(encrypted.data))],
  ]);
  const fetchImpl: typeof fetch = async (url) =>
    responses.get(inputUrl(url)) ?? new Response("missing", { status: 404 });

  const result = await fetchShare("https://share.example/", {
    passphrase: "open sesame",
    fetchImpl,
  });

  assert.equal(result.manifest.name, "shared.txt");
  assert.deepEqual(result.data, source);
});

test("resolves the manifest beside an index page URL", async () => {
  const source = Buffer.from("encrypted bytes");
  const encrypted = await encryptBuffer(source, "route phrase");
  const manifest = {
    format: CFSHARE_FORMAT,
    name: "encrypted.txt",
    type: "text/plain",
    size: source.length,
    storedSize: encrypted.data.length,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    payloads: [{ path: "payload-000.bin", size: encrypted.data.length }],
    crypto: encrypted.crypto,
  };
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    requested.push(inputUrl(url));
    return inputUrl(url).endsWith("cfshare.json")
      ? new Response(JSON.stringify(manifest))
      : new Response(new Uint8Array(encrypted.data));
  };

  await fetchShare("https://share.example/index.html", {
    passphrase: "route phrase",
    fetchImpl,
  });

  assert.equal(requested[0], "https://share.example/cfshare.json");
});

test("resolves a slashless self-hosted share path", async () => {
  const source = Buffer.from("encrypted bytes");
  const encrypted = await encryptBuffer(source, "route phrase");
  const manifest = {
    format: CFSHARE_FORMAT,
    name: "encrypted.txt",
    type: "text/plain",
    size: source.length,
    storedSize: encrypted.data.length,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    payloads: [{ path: "payload-000.bin", size: encrypted.data.length }],
    crypto: encrypted.crypto,
  };
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    requested.push(inputUrl(url));
    return inputUrl(url).endsWith("cfshare.json")
      ? new Response(JSON.stringify(manifest))
      : new Response(new Uint8Array(encrypted.data));
  };

  await fetchShare("https://share.example/abcdefghijklmnopqrst", {
    passphrase: "route phrase",
    fetchImpl,
  });

  assert.equal(requested[0], "https://share.example/abcdefghijklmnopqrst/cfshare.json");
});

test("rejects a payload before buffering beyond its declared size", async () => {
  const source = Buffer.from("size checked");
  const encrypted = await encryptBuffer(source, "size phrase");
  const manifest = {
    format: CFSHARE_FORMAT,
    name: "checked.txt",
    type: "text/plain",
    size: source.length,
    storedSize: encrypted.data.length,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    payloads: [{ path: "payload.bin", size: encrypted.data.length }],
    crypto: encrypted.crypto,
  };
  const fetchImpl: typeof fetch = async (url) =>
    inputUrl(url).endsWith("cfshare.json")
      ? Response.json(manifest)
      : new Response(Buffer.concat([encrypted.data, Buffer.from([0])]));

  await assert.rejects(
    fetchShare("https://share.example/transfer/", {
      passphrase: "size phrase",
      fetchImpl,
    }),
    /Payload size does not match|exceeds its declared size/,
  );
});
