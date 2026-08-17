import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseDeploymentOutput } from "../src/cloudflare";

test("extracts temporary preview and claim URLs from Wrangler output", () => {
  const output = `
Temporary account ready:
  Claim URL: https://dash.cloudflare.com/claim-preview?claimToken=private-token
Deployed cfshare-123 triggers
  https://cfshare-123.silent-river.workers.dev
`;

  assert.deepEqual(parseDeploymentOutput(output), {
    previewUrl: "https://cfshare-123.silent-river.workers.dev",
    claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=private-token",
  });
});
