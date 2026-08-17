import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { createShareBundle } from "../src/site";
import { decryptBuffer } from "../src/crypto";
import { fromBufferPromise } from "yauzl";

test("builds a browser-decryptable encrypted site", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "sample.txt");
  const sitePath = join(root, "site");
  const source = Buffer.from("hello from an expiring share");

  await writeFile(sourcePath, source);

  const metadata = await createShareBundle({
    inputPath: sourcePath,
    outputDir: sitePath,
    passphrase: "visitor phrase",
    now: new Date("2026-08-07T12:00:00.000Z"),
  });

  const storedMetadata = JSON.parse(await readFile(join(sitePath, "cfshare.json"), "utf8"));
  const payload = Buffer.concat(
    await Promise.all(metadata.payloads.map(({ path }) => readFile(join(sitePath, path)))),
  );
  const html = await readFile(join(sitePath, "index.html"), "utf8");

  assert.deepEqual(storedMetadata, metadata);
  assert.equal(metadata.storedSize, source.length + 16);
  assert.equal(metadata.expiresAt, "2026-08-07T13:00:00.000Z");
  assert.deepEqual(await decryptBuffer(payload, "visitor phrase", metadata.crypto), source);
  assert.match(html, /crypto\.subtle\.deriveKey/);
  assert.match(html, /Wrong passphrase/);
  assert.doesNotMatch(html, /visitor phrase/);

  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  if (!script) {
    assert.fail("Generated landing page did not contain a script");
  }

  assert.doesNotThrow(() => new Script(script));
});

test("supports smaller chunks for Durable Object values", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-chunk-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "sample.bin");

  await writeFile(sourcePath, Buffer.from("abcdefghij"));

  const metadata = await createShareBundle({
    inputPath: sourcePath,
    outputDir: join(root, "site"),
    chunkSize: 4,
    passphrase: "chunk phrase",
  });

  assert.deepEqual(
    metadata.payloads.map(({ size }) => size),
    [4, 4, 4, 4, 4, 4, 2],
  );
});

test("requires a passphrase to build a share", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-passphrase-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "sample.txt");

  await writeFile(sourcePath, "secret");

  await assert.rejects(
    createShareBundle({
      inputPath: sourcePath,
      outputDir: join(root, "site"),
      passphrase: "",
    }),
    /non-empty passphrase/,
  );
});

test("rejects invalid chunk sizes before writing a bundle", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-invalid-chunk-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "sample.txt");
  await writeFile(sourcePath, "secret");

  await assert.rejects(
    createShareBundle({
      inputPath: sourcePath,
      outputDir: join(root, "site"),
      passphrase: "chunk phrase",
      chunkSize: 0,
    }),
    /Chunk size must be an integer/,
  );
});

test("recursively ZIPs a directory before encryption", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-directory-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const sourcePath = join(root, "project");
  const sitePath = join(root, "site");

  await mkdir(join(sourcePath, "src"), { recursive: true });
  await writeFile(join(sourcePath, "src", "index.ts"), "export {};\n");

  const metadata = await createShareBundle({
    inputPath: sourcePath,
    outputDir: sitePath,
    passphrase: "folder phrase",
  });

  const payload = Buffer.concat(
    await Promise.all(metadata.payloads.map(({ path }) => readFile(join(sitePath, path)))),
  );
  const archive = await decryptBuffer(payload, "folder phrase", metadata.crypto);
  const zipFile = await fromBufferPromise(archive, { autoClose: false });
  const entries: string[] = [];

  try {
    for await (const entry of zipFile.eachEntry()) {
      entries.push(entry.fileName);
    }
  } finally {
    zipFile.close();
  }

  assert.equal(metadata.name, "project.zip");
  assert.equal(metadata.type, "application/zip");
  assert.equal(metadata.size, archive.length);
  assert.deepEqual(entries, ["project/", "project/src/", "project/src/index.ts"]);
  assert.deepEqual((await readdir(sitePath)).sort(), [
    "_headers",
    "cfshare.json",
    "index.html",
    "payload-000.bin",
  ]);
});
