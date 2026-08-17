import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { decryptBuffer, encryptBuffer, PBKDF2_ITERATIONS } from "../src/crypto";
import { generatePassphrase } from "../src/passphrase";

test("generates strong pronounceable passphrases", () => {
  const first = generatePassphrase();
  const second = generatePassphrase();

  assert.match(first, /^(?:[bcdfghjkmnprstvw][aeio]){3}(?:-(?:[bcdfghjkmnprstvw][aeio]){3}){5}$/);
  assert.notEqual(first, second);
});

test("encrypts and decrypts with a passphrase", async () => {
  const source = Buffer.from("the transfer stays private");
  const encrypted = await encryptBuffer(source, "correct horse");

  assert.equal(encrypted.crypto.iterations, PBKDF2_ITERATIONS);
  assert.notDeepEqual(encrypted.data, source);
  assert.deepEqual(await decryptBuffer(encrypted.data, "correct horse", encrypted.crypto), source);
});

test("rejects an incorrect passphrase", async () => {
  const encrypted = await encryptBuffer(Buffer.from("secret"), "right phrase");

  await assert.rejects(
    decryptBuffer(encrypted.data, "wrong phrase", encrypted.crypto),
    /Wrong passphrase or corrupted share/,
  );
});
