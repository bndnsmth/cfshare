import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { publicOrigin } from "../worker/src/origin";

test("uses the request origin by default", () => {
  assert.equal(publicOrigin(new Request("https://share.example/path")), "https://share.example");
});

test("uses a configured HTTPS public origin", () => {
  assert.equal(
    publicOrigin(new Request("http://127.0.0.1:8080/path"), "https://share.example"),
    "https://share.example",
  );
});

test("rejects unsafe or malformed public origins", () => {
  const request = new Request("http://127.0.0.1:8080/path");

  assert.equal(publicOrigin(request, "http://share.example"), "http://127.0.0.1:8080");
  assert.equal(publicOrigin(request, "https://share.example/path"), "http://127.0.0.1:8080");
  assert.equal(publicOrigin(request, "not a URL"), "http://127.0.0.1:8080");
});
