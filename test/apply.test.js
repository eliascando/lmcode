const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const { applyChanges, parseApplyBlocks } = require("../src/apply");
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

test("applyChanges accepts malformed READ and FILE tags with short closing markers", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lmcode-apply-"));
  await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "src/app.js"), "console.log('old');\n", "utf8");
  await fs.writeFile(path.join(rootDir, "src/extra.js"), "export const extra = true;\n", "utf8");
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

  let callCount = 0;
  const askModel = async () => {
    callCount += 1;
    if (callCount === 1) {
      return "<<<READ:src/extra.js>>";
    }

    return [
      "<<<FILE:src/app.js>>",
      "console.log('new');",
      "<<<END FILE>>",
      "<<<FILE:src/extra.js>",
      "export const extra = false;",
      "<<<END FILE>",
    ].join("\n");
  };

  const applied = await applyChanges(
    state,
    "model",
    "actualiza archivos",
    { askModel, ui: createFakeUi() },
    { autoConfirm: true }
  );

  assert.equal(applied, true);
  assert.equal(callCount, 2);
  assert.equal(
    await fs.readFile(path.join(rootDir, "src/app.js"), "utf8"),
    "console.log('new');"
  );
  assert.equal(
    await fs.readFile(path.join(rootDir, "src/extra.js"), "utf8"),
    "export const extra = false;"
  );
});

test("parseApplyBlocks accepts file blocks without a newline before the closing tag", () => {
  const blocks = parseApplyBlocks(
    ["<<<FILE:src/app.js>>>", "console.log('new');<<<END FILE>>>", ""].join("\n")
  );

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].relativePath, "src/app.js");
  assert.equal(blocks[0].content, "console.log('new');");
});

test("applyChanges denies file modifications in read-only mode", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lmcode-apply-"));
  await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "src/app.js"), "console.log('old');\n", "utf8");

  const state = createState({ ...createOptions(), permissionMode: "read-only" }, rootDir);
  replaceSelectedFiles(state, ["src/app.js"], "manual");

  let called = false;
  const askModel = async () => {
    called = true;
    return [
      "<<<FILE:src/app.js>>>",
      "console.log('new');",
      "<<<END FILE>>>",
    ].join("\n");
  };

  const applied = await applyChanges(
    state,
    "model",
    "actualiza archivo",
    { askModel, ui: createFakeUi() },
    { autoConfirm: true }
  );

  assert.equal(applied, false);
  assert.equal(called, false);
  assert.equal(
    await fs.readFile(path.join(rootDir, "src/app.js"), "utf8"),
    "console.log('old');\n"
  );
});
