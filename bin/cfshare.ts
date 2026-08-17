#!/usr/bin/env node

import { run } from "../src/cli";

run(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`\ncfshare: ${message}`);
  process.exitCode = 1;
});
