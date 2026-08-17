import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli";

test("parses an implicit send command", () => {
  assert.deepEqual(parseArgs(["archive.zip", "--password=secret", "--yes"]), {
    command: "send",
    yes: true,
    json: false,
    force: false,
    password: "secret",
    target: "archive.zip",
  });
});

test("generates a passphrase when the password option is absent", () => {
  assert.deepEqual(parseArgs(["archive.zip", "--yes"]), {
    command: "send",
    yes: true,
    json: false,
    force: false,
    target: "archive.zip",
  });
});

test("allows password prompt flag before the target", () => {
  assert.deepEqual(parseArgs(["--password", "archive.zip"]), {
    command: "send",
    yes: false,
    json: false,
    force: false,
    password: true,
    target: "archive.zip",
  });
});

test("rejects command-specific options on the wrong command", () => {
  assert.throws(() => parseArgs(["archive.zip", "--force"]), /only valid with 'cfshare get'/);
  assert.throws(
    () => parseArgs(["get", "https://share.example", "--ttl", "1h"]),
    /only valid when sending/,
  );
});

test("parses self-hosted server and TTL options", () => {
  assert.deepEqual(
    parseArgs(["bundle.zip", "--server", "https://share.example.com", "--ttl", "12h", "--json"]),
    {
      command: "send",
      yes: false,
      json: true,
      force: false,
      server: "https://share.example.com",
      ttl: "12h",
      target: "bundle.zip",
    },
  );
});

test("parses server configuration commands", () => {
  assert.deepEqual(parseArgs(["config", "set", "server", "https://share.example.com"]), {
    command: "config",
    action: "set-server",
    value: "https://share.example.com",
  });
  assert.deepEqual(parseArgs(["config", "show"]), { command: "config", action: "show" });
});
