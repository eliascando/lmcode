const test = require("node:test");
const assert = require("node:assert/strict");

const { isDangerousCommand, parseAgentResponse } = require("../src/agent");

test("parseAgentResponse accepts LIST without filter", () => {
  const action = parseAgentResponse({}, "<<<LIST>>>", (text) => text);
  assert.deepEqual(action, { type: "list", filter: "" });
});

test("parseAgentResponse detects write blocks", () => {
  const action = parseAgentResponse(
    {},
    ["<<<FILE:src/app.js>>>", "console.log('ok');", "<<<END FILE>>>"].join("\n"),
    (text) => text
  );

  assert.equal(action.type, "write");
  assert.equal(action.files.length, 1);
  assert.equal(action.files[0].relativePath, "src/app.js");
});

test("parseAgentResponse rejects mixed actions", () => {
  const action = parseAgentResponse(
    {},
    ["<<<READ:src/app.js>>>", "<<<RUN:npm test>>>"].join("\n"),
    (text) => text
  );

  assert.equal(action.type, "invalid");
});

test("parseAgentResponse accepts plain READ syntax", () => {
  const action = parseAgentResponse({}, "LEER src/app.js", (text) => text);
  assert.deepEqual(action, { type: "read", paths: ["src/app.js"] });
});

test("parseAgentResponse accepts plain FILE blocks", () => {
  const action = parseAgentResponse(
    {},
    ["ARCHIVO: src/app.js", "console.log('ok');", "FIN ARCHIVO"].join("\n"),
    (text) => text
  );

  assert.equal(action.type, "write");
  assert.equal(action.files.length, 1);
  assert.equal(action.files[0].relativePath, "src/app.js");
});

test("parseAgentResponse accepts plain FINAL syntax", () => {
  const action = parseAgentResponse({}, "FINAL: tarea completada", (text) => text);
  assert.deepEqual(action, { type: "final", content: "tarea completada" });
});

test("isDangerousCommand flags destructive commands", () => {
  assert.equal(isDangerousCommand("rm -rf dist"), true);
  assert.equal(isDangerousCommand("git reset --hard HEAD~1"), true);
  assert.equal(isDangerousCommand("npm test"), false);
  assert.equal(isDangerousCommand("rg workflow src"), false);
});
