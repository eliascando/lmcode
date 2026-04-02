const { argv, exit, stdin, version } = require("node:process");

const { PERMISSION_MODES, UI_MODES, parseArgs, printHelp } = require("./config");
const core = require("./core");
const lmstudio = require("./lmstudio");
const ui = require("./ui");
const { applyChanges, previewPatch } = require("./apply");
const { runAgentLoop } = require("./agent");

function printCompactionNotice(compacted, uiAdapter = ui) {
  if (compacted) {
    uiAdapter.writeLine(`[contexto resumido: ${compacted.reason}]`);
  }
}

function buildMessages(state, prompt) {
  return [
    { role: "system", content: state.options.systemPrompt },
    {
      role: "system",
      content: `Contexto del proyecto actual:\n${state.contextBlock}`,
    },
    ...core.makeConversationMessages(state, prompt),
  ];
}

function createAskModel(uiAdapter = ui) {
  return async function askModel(state, model, prompt, options = {}) {
    if (!options.skipCompact) {
      const compacted = core.maybeCompactConversation(state, prompt);
      printCompactionNotice(compacted, uiAdapter);
    }

    state.contextBlock = await core.buildContextBlock(state);
    const messages = buildMessages(state, prompt);
    return lmstudio.chatCompletion(state.options.baseUrl, model, messages);
  };
}

function recordConversationTurn(state, prompt, answer) {
  if (!answer) {
    return;
  }

  state.history.push({ role: "user", content: prompt });
  state.history.push({ role: "assistant", content: answer });
}

function applyModelSelection(state, selected, successMessage, uiAdapter = ui) {
  state.contextWindowTokens = selected.contextLength || state.contextWindowTokens;
  state.history = [];
  state.summary = "";
  state.expandedFiles.clear();
  state.fileContextBudgets.clear();
  if (typeof uiAdapter.setModel === "function") {
    uiAdapter.setModel(selected.key);
  }
  uiAdapter.writeLine(successMessage(selected.key));
}

function printFiles(state, filter = "", uiAdapter = ui) {
  const result = core.listFiles(state, filter);
  if (!result.files.length) {
    uiAdapter.writeLine("No se encontraron archivos.");
    return;
  }

  result.preview.forEach((filePath) => uiAdapter.writeLine(filePath));
  if (result.hiddenCount > 0) {
    uiAdapter.writeLine(`[+${result.hiddenCount} archivos mas]`);
  }
}

async function printReadFile(state, query, uiAdapter = ui) {
  const result = await core.readFileContent(state, query);
  if (result.error) {
    uiAdapter.errorLine(result.error);
    if (result.matches) {
      result.matches.forEach((filePath) => uiAdapter.errorLine(filePath));
    }
    return;
  }

  uiAdapter.writeLine(result.content);
}

async function printDoctor(state, uiAdapter = ui) {
  const lines = [
    "LM Code Doctor",
    `Node.js: ${version}`,
    `Proyecto: ${state.rootDir}`,
    `Repositorio git: ${state.isGitRepo ? "si" : "no"}`,
    `git: ${core.commandExists("git") ? "ok" : "faltante"}`,
    `rg: ${core.commandExists("rg") ? "ok" : "faltante"}`,
    `Permisos: ${core.getPermissionMode(state)}`,
    `LM Studio base URL: ${state.options.baseUrl}`,
  ];

  try {
    const models = await lmstudio.fetchModels(state.options.baseUrl);
    const loaded = models.filter(
      (model) => Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0
    );
    lines.push("LM Studio: ok");
    lines.push(`Modelos detectados: ${models.length}`);
    lines.push(`Modelos cargados: ${loaded.length}`);
    if (loaded[0]?.key) {
      lines.push(`Primer modelo cargado: ${loaded[0].key}`);
    }
  } catch (error) {
    lines.push("LM Studio: error");
    lines.push(error instanceof Error ? error.message : String(error));
  }

  uiAdapter.writeLine(lines.join("\n"));
}

async function runOneShot(state, model, prompt, uiAdapter = ui) {
  const result = await runAgentLoop(state, model, prompt, uiAdapter);
  recordConversationTurn(state, prompt, result.finalText || result.rawAnswer);
}

async function runInteractive(state, model, uiAdapter = ui) {
  const askModel = createAskModel(uiAdapter);
  uiAdapter.printStartupBanner(state, model);

  while (true) {
    const input = await uiAdapter.readFancyInput(state, model);

    if (input === null) {
      return;
    }

    if (!input) {
      continue;
    }

    try {
      if (input === "/exit" || input === "/quit") {
        return;
      }

      if (input === "/help") {
        uiAdapter.writeLine(
          "/models  /model  /model <id>  /load  /load <id>  /status  /permissions [modo]  /doctor  /files [filtro]  /add <ruta>  /drop <ruta>  /context  /read <ruta>  /run <cmd>  /diff  /patch <inst>  /apply <inst>  /summary  /compact  /clear  /reset  /exit"
        );
        continue;
      }

      if (input === "/models") {
        lmstudio.printModels(uiAdapter, await lmstudio.fetchModels(state.options.baseUrl));
        continue;
      }

      if (input.startsWith("/model ")) {
        const selected = await lmstudio.switchModel(
          state.options.baseUrl,
          model,
          input.slice(7).trim(),
          false,
          uiAdapter
        );
        model = selected.key;
        applyModelSelection(state, selected, (key) => `Modelo cambiado a ${key}`, uiAdapter);
        continue;
      }

      if (input === "/model" || input === "/load") {
        const selected = await lmstudio.switchModel(
          state.options.baseUrl,
          model,
          "",
          true,
          uiAdapter,
          true
        );
        model = selected.key;
        applyModelSelection(state, selected, (key) => `Modelo activo: ${key}`, uiAdapter);
        continue;
      }

      if (input.startsWith("/load ")) {
        const selected = await lmstudio.switchModel(
          state.options.baseUrl,
          model,
          input.slice(6).trim(),
          false,
          uiAdapter
        );
        model = selected.key;
        applyModelSelection(state, selected, (key) => `Modelo activo: ${key}`, uiAdapter);
        continue;
      }

      if (input === "/status") {
        uiAdapter.writeLine(core.getStatusSummary(state, model));
        continue;
      }

      if (input === "/permissions") {
        uiAdapter.writeLine(`Permisos actuales: ${core.getPermissionMode(state)}`);
        continue;
      }

      if (input.startsWith("/permissions ")) {
        const requested = input.slice(13).trim().toLowerCase();
        if (!PERMISSION_MODES.includes(requested)) {
          uiAdapter.errorLine(`Modo invalido. Usa: ${PERMISSION_MODES.join(" | ")}`);
          continue;
        }

        state.options.permissionMode = requested;
        uiAdapter.writeLine(`Permisos cambiados a ${requested}`);
        continue;
      }

      if (input === "/doctor") {
        await printDoctor(state, uiAdapter);
        continue;
      }

      if (input === "/clear") {
        state.history = [];
        state.summary = "";
        state.expandedFiles.clear();
        uiAdapter.writeLine("Conversacion limpiada.");
        continue;
      }

      if (input === "/reset") {
        state.history = [];
        state.summary = "";
        state.selectedFiles.clear();
        state.selectionMode = "none";
        state.expandedFiles.clear();
        state.fileContextBudgets.clear();
        state.lastCommandOutput = "";
        uiAdapter.writeLine("Contexto reiniciado.");
        continue;
      }

      if (input === "/summary") {
        if (!state.summary) {
          uiAdapter.writeLine("No hay resumen acumulado todavia.");
        } else {
          uiAdapter.writeLine(state.summary);
        }
        continue;
      }

      if (input === "/compact") {
        const compacted = core.compactConversation(state, "manual");
        if (!compacted) {
          uiAdapter.writeLine("No habia historial para resumir.");
        } else {
          printCompactionNotice(compacted, uiAdapter);
        }
        continue;
      }

      if (input.startsWith("/files")) {
        printFiles(state, input.slice(6), uiAdapter);
        continue;
      }

      if (input.startsWith("/add ")) {
        const { added, warnings } = core.addFiles(state, [input.slice(5).trim()], "manual");
        warnings.forEach((warning) => uiAdapter.errorLine(warning));
        if (added.length) {
          uiAdapter.writeLine(`Agregados:\n${added.join("\n")}`);
        }
        continue;
      }

      if (input.startsWith("/drop ")) {
        const { removed, warnings } = core.dropFiles(state, [input.slice(6).trim()]);
        warnings.forEach((warning) => uiAdapter.errorLine(warning));
        if (removed.length) {
          uiAdapter.writeLine(`Quitados:\n${removed.join("\n")}`);
        }
        continue;
      }

      if (input === "/context") {
        uiAdapter.writeLine(core.getContextSummary(state));
        continue;
      }

      if (input.startsWith("/read ")) {
        await printReadFile(state, input.slice(6).trim(), uiAdapter);
        continue;
      }

      if (input.startsWith("/run ")) {
        const result = core.runShellCommand(state, input.slice(5).trim());
        uiAdapter.writeLine(result.output);
        continue;
      }

      if (input === "/diff") {
        uiAdapter.writeLine(core.getGitDiff(state).output);
        continue;
      }

      if (input.startsWith("/patch ")) {
        await previewPatch(state, model, input.slice(7).trim(), { askModel, ui: uiAdapter });
        continue;
      }

      if (input.startsWith("/apply ")) {
        await applyChanges(state, model, input.slice(7).trim(), {
          askModel,
          ui: uiAdapter,
        });
        continue;
      }

      const result = await runAgentLoop(state, model, input, uiAdapter);
      recordConversationTurn(state, input, result.finalText || result.rawAnswer);
    } catch (error) {
      uiAdapter.errorLine(error instanceof Error ? error.message : String(error));
    }
  }
}

function resolveUiMode(options) {
  const candidate = String(options.uiMode || "auto").trim().toLowerCase();
  return UI_MODES.includes(candidate) ? candidate : "auto";
}

async function runPreferredInteractiveUi(state, model) {
  const uiMode = resolveUiMode(state.options);
  if (!stdin.isTTY || uiMode === "classic") {
    await runInteractive(state, model, ui);
    return;
  }

  if (uiMode === "react" || uiMode === "auto") {
    try {
      const { runReactInteractive } = await import("./ui-react.mjs");
      await runReactInteractive(state, model, { runInteractive });
      return;
    } catch (error) {
      if (uiMode === "react") {
        throw error;
      }

      ui.errorLine(
        `No pude iniciar la UI React. Vuelvo a la interfaz clasica. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  await runInteractive(state, model, ui);
}

async function main() {
  const options = parseArgs(argv.slice(2));

  if (options.help) {
    printHelp(ui.write);
    return;
  }

  const state = core.createState(options);

  if (options.doctor) {
    await printDoctor(state, ui);
    return;
  }

  if (options.listModels) {
    lmstudio.printModels(ui, await lmstudio.fetchModels(options.baseUrl));
    return;
  }

  if (options.addQueries.length > 0) {
    const { warnings } = core.addFiles(state, options.addQueries, "manual");
    warnings.forEach((warning) => ui.errorLine(warning));
  }

  const selectedModel = await lmstudio.chooseModel(
    options.baseUrl,
    options.modelQuery,
    !options.prompt && stdin.isTTY,
    ui
  );
  const model = selectedModel.key;
  state.contextWindowTokens = selectedModel.contextLength || state.contextWindowTokens;
  const prompt = await core.readStdinIfNeeded(options.prompt);

  if (prompt) {
    await runOneShot(state, model, prompt, ui);
    return;
  }

  await runPreferredInteractiveUi(state, model);
}

module.exports = {
  main,
  runInteractive,
};

if (require.main === module) {
  main().catch((error) => {
    ui.errorLine(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
