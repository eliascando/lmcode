const test = require("node:test");
const assert = require("node:assert/strict");

const { confirmDangerousRun } = require("../src/cli");

function createState(permissionMode = "workspace-write") {
  return {
    options: { permissionMode },
  };
}

test("confirmDangerousRun allows safe commands without prompting", async () => {
  let prompted = false;
  const allowed = await confirmDangerousRun(createState(), "npm test", {
    askPlainQuestion: async () => {
      prompted = true;
      return "n";
    },
  });

  assert.equal(allowed, true);
  assert.equal(prompted, false);
});

test("confirmDangerousRun rejects dangerous commands when user declines", async () => {
  const allowed = await confirmDangerousRun(createState(), "rm -rf dist", {
    askPlainQuestion: async () => "n",
  });

  assert.equal(allowed, false);
});

test("confirmDangerousRun skips prompt in danger-full-access mode", async () => {
  let prompted = false;
  const allowed = await confirmDangerousRun(createState("danger-full-access"), "rm -rf dist", {
    askPlainQuestion: async () => {
      prompted = true;
      return "n";
    },
  });

  assert.equal(allowed, true);
  assert.equal(prompted, false);
});
