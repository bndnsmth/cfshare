import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { JsonObject, JsonValue } from "../src/json";
import { parseManifest } from "../src/manifest";
import { CFSHARE_FORMAT, PBKDF2_ITERATIONS } from "../src/types";
import { parseUploadManifest } from "../worker/src/protocol";

const MAX_UPLOAD = 262144016;

function uploadManifest(overrides: JsonObject = {}) {
  return {
    format: CFSHARE_FORMAT,
    name: "demo.txt",
    type: "text/plain",
    size: 3,
    storedSize: 19,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    payloads: [{ path: "payload-000.bin", size: 19 }],
    crypto: {
      algorithm: "AES-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      iv: "AAAAAAAAAAAAAAAA",
    },
    ...overrides,
  };
}

function manifestError(value: JsonValue): string | null {
  const result = parseUploadManifest(value, MAX_UPLOAD);

  return result.ok ? null : result.error;
}

test("accepts a consistent manifest", () => {
  assert.equal(manifestError(uploadManifest()), null);
});

test("rejects unsupported transfer formats", () => {
  assert.match(manifestError(uploadManifest({ format: "cfshare/v2" })) ?? "", /format/);
});

test("rejects invalid stored and payload sizes", () => {
  assert.match(manifestError(uploadManifest({ storedSize: MAX_UPLOAD + 1 })) ?? "", /stored size/);
  assert.match(
    manifestError(
      uploadManifest({
        payloads: [{ path: "payload-000.bin", size: 18 }],
      }),
    ) ?? "",
    /payload sizes/i,
  );
});

test("accepts small stream segments and enforces the transport ceiling", () => {
  const oneMiB = 1024 * 1024;
  const fiftyOneMiB = 51 * 1024 * 1024;
  assert.equal(
    manifestError(
      uploadManifest({
        storedSize: 2 * oneMiB,
        payloads: [
          { path: "payload-000.bin", size: oneMiB },
          { path: "payload-001.bin", size: oneMiB },
        ],
      }),
    ),
    null,
  );
  assert.match(
    manifestError(
      uploadManifest({
        storedSize: fiftyOneMiB,
        payloads: [{ path: "payload-000.bin", size: fiftyOneMiB }],
      }),
    ) ?? "",
    /payload descriptor/i,
  );
});

test("allows a large combined download while keeping upload segments bounded", () => {
  const fiftyOneMiB = 51 * 1024 * 1024;
  const combinedManifest = uploadManifest({
    storedSize: fiftyOneMiB,
    payloads: [{ path: "payload.bin", size: fiftyOneMiB }],
  });

  assert.equal(parseManifest(combinedManifest).ok, true);
  assert.match(manifestError(combinedManifest) ?? "", /payload descriptor/i);
});

test("rejects incomplete and malformed manifests", () => {
  assert.match(manifestError(uploadManifest({ name: null })) ?? "", /name/i);
  assert.match(manifestError(uploadManifest({ payloads: [null] })) ?? "", /descriptor/i);
  assert.match(
    manifestError(uploadManifest({ crypto: { algorithm: "AES-GCM" } })) ?? "",
    /crypto/i,
  );
  assert.match(
    manifestError(uploadManifest({ payloads: [{ path: "../payload.bin", size: 19 }] })) ?? "",
    /descriptor/i,
  );
});
