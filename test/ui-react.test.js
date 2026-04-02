const test = require("node:test");
const assert = require("node:assert/strict");

async function loadUiReact() {
  return import("../src/ui-react.mjs");
}

test("getSlashSuggestions returns matching slash commands", async () => {
  const { getSlashSuggestions } = await loadUiReact();

  const suggestions = getSlashSuggestions("/mo");

  assert.deepEqual(
    suggestions.map((entry) => entry.command),
    ["/models", "/model"]
  );
});

test("completeSlashCommand autocompletes the first matching slash command", async () => {
  const { completeSlashCommand } = await loadUiReact();

  assert.equal(completeSlashCommand("/do"), "/doctor ");
  assert.equal(completeSlashCommand("  /sta"), "  /status ");
  assert.equal(completeSlashCommand("hola"), "hola");
});

test("buildCommandPaletteItems exposes context selector and dynamic permission action", async () => {
  const { buildCommandPaletteItems } = await loadUiReact();

  const items = buildCommandPaletteItems({
    options: {permissionMode: "workspace-write"},
    selectedFiles: new Set(),
    projectFiles: [],
  });

  const contextItem = items.find((item) => item.openPalette === "context");
  const permissionItem = items.find((item) => item.command === "/permissions read-only");

  assert.equal(contextItem?.label, "Archivos y contexto");
  assert.equal(permissionItem?.label, "Pasar a solo lectura");
});

test("buildContextPaletteItems prioritizes selected files and toggles add-drop commands", async () => {
  const { buildContextPaletteItems } = await loadUiReact();

  const items = buildContextPaletteItems({
    selectedFiles: new Set(["src/app.js"]),
    projectFiles: ["package.json", "src/app.js", "README.md", "test/app.test.js"],
  });

  assert.equal(items[0].label, "src/app.js");
  assert.equal(items[0].command, "/drop src/app.js");
  assert.equal(items[1].label, "README.md");
  assert.equal(items[2].label, "package.json");
  assert.equal(items[3].command, "/add test/app.test.js");
});

test("filterPaletteItems matches labels, descriptions and keywords", async () => {
  const { filterPaletteItems } = await loadUiReact();

  const items = [
    {label: "Doctor", description: "Diagnostico", keywords: "salud entorno"},
    {label: "Diff git", description: "Cambios", keywords: "git diff"},
  ];

  assert.deepEqual(
    filterPaletteItems(items, "salud").map((item) => item.label),
    ["Doctor"]
  );
  assert.deepEqual(
    filterPaletteItems(items, "diff").map((item) => item.label),
    ["Diff git"]
  );
});

test("getResponsiveLayout switches to compact mode on narrow terminals", async () => {
  const { getResponsiveLayout } = await loadUiReact();

  assert.deepEqual(getResponsiveLayout(100), {
    compact: true,
    dense: false,
    maxLogs: 22,
    mainWidth: 100,
    sideWidth: 100,
  });
});

test("getResponsiveLayout computes bounded side panel widths on wide terminals", async () => {
  const { getResponsiveLayout } = await loadUiReact();

  assert.deepEqual(getResponsiveLayout(160), {
    compact: false,
    dense: false,
    maxLogs: 22,
    mainWidth: 117,
    sideWidth: 41,
  });
});

test("getResponsiveLayout stays compact on mid-sized terminals", async () => {
  const { getResponsiveLayout } = await loadUiReact();

  assert.deepEqual(getResponsiveLayout(140), {
    compact: true,
    dense: false,
    maxLogs: 22,
    mainWidth: 140,
    sideWidth: 140,
  });
});

test("getResponsiveLayout reduces visible logs on short terminals", async () => {
  const { getResponsiveLayout } = await loadUiReact();

  assert.deepEqual(getResponsiveLayout(160, 30), {
    compact: false,
    dense: true,
    maxLogs: 12,
    mainWidth: 117,
    sideWidth: 41,
  });
});

test("getPickerWindow centers the selected item inside the visible slice", async () => {
  const { getPickerWindow } = await loadUiReact();

  const windowed = getPickerWindow(
    Array.from({length: 20}, (_, index) => ({label: `item-${index}`})),
    10,
    6
  );

  assert.equal(windowed.start, 7);
  assert.equal(windowed.items.length, 6);
  assert.equal(windowed.items[3].label, "item-10");
});
