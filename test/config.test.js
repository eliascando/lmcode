const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("../src/config");

test("parseArgs reads doctor and permission mode flags", () => {
  const options = parseArgs([
    "--doctor",
    "--permission-mode",
    "read-only",
    "--model",
    "qwen/test",
    "hola",
  ]);

  assert.equal(options.doctor, true);
  assert.equal(options.permissionMode, "read-only");
  assert.equal(options.modelQuery, "qwen/test");
  assert.equal(options.prompt, "hola");
});

test("parseArgs dangerously-skip-permissions enables danger-full-access", () => {
  const options = parseArgs(["--dangerously-skip-permissions"]);

  assert.equal(options.permissionMode, "danger-full-access");
});

test("parseArgs reads ui mode flag", () => {
  const options = parseArgs(["--ui", "react"]);

  assert.equal(options.uiMode, "react");
});
