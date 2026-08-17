import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeServerUrl, readConfig, writeConfig } from "../src/config";

test("normalizes secure server origins", () => {
  assert.equal(normalizeServerUrl("https://share.example.com/"), "https://share.example.com");
  assert.equal(normalizeServerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeServerUrl("drop"), "drop");
  assert.throws(() => normalizeServerUrl("http://share.example.com"), /must use HTTPS/);
  assert.throws(() => normalizeServerUrl("ftp://localhost"), /must use HTTPS/);
  assert.throws(() => normalizeServerUrl("ws://127.0.0.1:8787"), /must use HTTPS/);
  assert.throws(() => normalizeServerUrl("https://share.example.com/path"), /without a path/);
});

test("writes and reads CLI configuration", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "cfshare-config-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const path = join(root, "nested", "config.json");

  await writeConfig({ server: "https://share.example.com" }, path);

  assert.deepEqual(await readConfig(path), { server: "https://share.example.com" });
});
