import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fromBufferPromise } from "yauzl";
import { createDirectoryArchive } from "../src/archive";

async function readArchive(data: Buffer): Promise<Map<string, Buffer | null>> {
  const entries = new Map<string, Buffer | null>();
  const zipFile = await fromBufferPromise(data, { autoClose: false });

  try {
    for await (const entry of zipFile.eachEntry()) {
      if (entry.fileName.endsWith("/")) {
        entries.set(entry.fileName, null);
        continue;
      }

      const stream = await zipFile.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }

      entries.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    zipFile.close();
  }

  return entries;
}

test("recursively archives hidden files and empty directories", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-archive-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const source = join(root, "photos");

  await mkdir(join(source, "nested", "empty"), { recursive: true });
  await writeFile(join(source, ".hidden"), "hidden");
  await writeFile(join(source, "nested", "photo.txt"), "photo");

  const archive = await createDirectoryArchive(source, 1024 * 1024);
  const entries = await readArchive(archive.data);

  assert.equal(archive.name, "photos.zip");
  assert.deepEqual(
    [...entries.keys()],
    [
      "photos/",
      "photos/.hidden",
      "photos/nested/",
      "photos/nested/empty/",
      "photos/nested/photo.txt",
    ],
  );
  assert.equal(entries.get("photos/.hidden")?.toString(), "hidden");
  assert.equal(entries.get("photos/nested/photo.txt")?.toString(), "photo");
});

test("rejects symbolic links inside a folder", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-archive-link-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const source = join(root, "folder");

  await mkdir(source);
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(source, "link.txt"));

  await assert.rejects(createDirectoryArchive(source, 1024 * 1024), /Symbolic links/);
});

test("enforces source and generated ZIP size limits", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-archive-limit-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const source = join(root, "folder");

  await mkdir(source);
  await writeFile(join(source, "large.txt"), "12345678901");

  await assert.rejects(createDirectoryArchive(source, 10), /Directory contents exceed/);

  await rm(join(source, "large.txt"));
  await assert.rejects(createDirectoryArchive(source, 10), /Generated ZIP exceeds/);
});

test("does not duplicate an existing zip extension", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-archive-name-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const source = join(root, "bundle.ZIP");

  await mkdir(source);

  const archive = await createDirectoryArchive(source, 1024 * 1024);

  assert.equal(archive.name, "bundle.ZIP");
});
