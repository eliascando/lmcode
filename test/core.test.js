const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const {
  createState,
  getGitDiff,
  getImplicitEditSelection,
  getStatusSummary,
  normalizePermissionMode,
  refreshProjectSnapshot,
  replaceSelectedFiles,
  runShellCommand,
} = require("../src/core");

function createOptions() {
  return {
    baseUrl: "http://127.0.0.1:1234",
    systemPrompt: "test",
    modelQuery: "",
    addQueries: [],
    listModels: false,
    permissionMode: "workspace-write",
    prompt: "",
  };
}

async function makeWorkspace(files, git = false) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lmcode-core-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }

  if (git) {
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
  }

  return rootDir;
}

test("implicit edit keeps manual selection but does not pin stale auto selection", async () => {
  const rootDir = await makeWorkspace({
    "src/profile.js": "export const profile = true;\n",
    "src/orders.js": "export const orders = true;\n",
  });
  const state = createState(createOptions(), rootDir);

  replaceSelectedFiles(state, ["src/profile.js"], "auto");
  assert.deepEqual(getImplicitEditSelection(state, "actualiza orders"), ["src/orders.js"]);

  replaceSelectedFiles(state, ["src/profile.js"], "manual");
  assert.deepEqual(getImplicitEditSelection(state, "actualiza orders"), ["src/profile.js"]);
});

test("refreshProjectSnapshot updates indexed files and git status", async () => {
  const rootDir = await makeWorkspace(
    {
      "src/app.js": "console.log('a');\n",
    },
    true
  );
  const state = createState(createOptions(), rootDir);
  assert.equal(state.gitStatus, "");

  await fs.writeFile(path.join(rootDir, "src/new-file.js"), "console.log('b');\n", "utf8");
  refreshProjectSnapshot(state);

  assert.equal(state.projectFiles.includes("src/new-file.js"), true);
  assert.match(state.gitStatus, /new-file\.js/);
});

test("normalizePermissionMode falls back to workspace-write", () => {
  assert.equal(normalizePermissionMode("read-only"), "read-only");
  assert.equal(normalizePermissionMode("workspace-write"), "workspace-write");
  assert.equal(normalizePermissionMode("danger-full-access"), "danger-full-access");
  assert.equal(normalizePermissionMode("cualquier-cosa"), "workspace-write");
});

test("runShellCommand denies execution in read-only mode", async () => {
  const rootDir = await makeWorkspace({
    "src/app.js": "console.log('a');\n",
  });
  const state = createState({ ...createOptions(), permissionMode: "read-only" }, rootDir);

  const result = runShellCommand(state, "pwd");

  assert.equal(result.denied, true);
  assert.match(result.output, /read-only/);
});

test("getGitDiff returns current diff", async () => {
  const rootDir = await makeWorkspace(
    {
      "src/app.js": "console.log('a');\n",
    },
    true
  );
  const state = createState(createOptions(), rootDir);
  await fs.writeFile(path.join(rootDir, "src/app.js"), "console.log('b');\n", "utf8");

  const result = getGitDiff(state);

  assert.equal(result.ok, true);
  assert.match(result.output, /console\.log\('b'\)/);
});

test("getStatusSummary includes permission mode and model", async () => {
  const rootDir = await makeWorkspace({
    "src/app.js": "console.log('a');\n",
  });
  const state = createState({ ...createOptions(), permissionMode: "read-only" }, rootDir);
  replaceSelectedFiles(state, ["src/app.js"], "manual");

  const summary = getStatusSummary(state, "qwen/test");

  assert.match(summary, /Permisos: read-only/);
  assert.match(summary, /Modelo: qwen\/test/);
  assert.match(summary, /src\/app\.js/);
});
