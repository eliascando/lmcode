const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const { createState, getImplicitEditSelection, refreshProjectSnapshot, replaceSelectedFiles } =
  require("../src/core");

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
