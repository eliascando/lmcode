const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const { applyChanges } = require("../src/apply");
const { createState, replaceSelectedFiles } = require("../src/core");

function createOptions() {
  return {
    baseUrl: "http://127.0.0.1:1234",
    systemPrompt: "test",
    modelQuery: "",
    addQueries: [],
    listModels: false,
    prompt: "",
  };
}

function createFakeUi() {
  return {
    theme: { dim: "" },
    paint: (text) => text,
    sanitizeConsoleResponse: (text) => text,
    write: () => {},
    writeLine: () => {},
    errorLine: () => {},
    askPlainQuestion: async () => "y",
    runWithSpinner: async (_model, _label, task) => task(),
  };
}

test("applyChanges refreshes project snapshot and keeps new files in selection", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lmcode-apply-"));
  await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "src/app.js"), "console.log('old');\n", "utf8");
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "lmcode@example.test"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "lmcode"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "."], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test"], { cwd: rootDir, stdio: "ignore" });

  const state = createState(createOptions(), rootDir);
  replaceSelectedFiles(state, ["src/app.js"], "manual");

  const askModel = async () => {
    return [
      "<<<FILE:src/app.js>>>",
      "console.log('new');",
      "<<<END FILE>>>",
      "<<<FILE:src/new-file.js>>>",
      "export const created = true;",
      "<<<END FILE>>>",
    ].join("\n");
  };

  const applied = await applyChanges(
    state,
    "model",
    "actualiza app y crea archivo",
    { askModel, ui: createFakeUi() },
    { autoConfirm: true }
  );

  assert.equal(applied, true);
  assert.equal(
    await fs.readFile(path.join(rootDir, "src/app.js"), "utf8"),
    "console.log('new');"
  );
  assert.equal(
    await fs.readFile(path.join(rootDir, "src/new-file.js"), "utf8"),
    "export const created = true;"
  );
  assert.equal(state.projectFiles.includes("src/new-file.js"), true);
  assert.equal(state.selectedFiles.has("src/new-file.js"), true);
  assert.match(state.gitStatus, /new-file\.js/);
});
