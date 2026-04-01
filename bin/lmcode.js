#!/usr/bin/env node

const { main } = require("../src/cli");

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
