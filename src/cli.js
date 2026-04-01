const { argv, exit, stdin } = require("node:process");

const { parseArgs, printHelp } = require("./config");
const core = require("./core");
const lmstudio = require("./lmstudio");
const ui = require("./ui");
const { applyChanges, previewPatch } = require("./apply");
const { runAgentLoop } = require("./agent");

function printCompactionNotice(compacted) {
  if (compacted) {
    ui.writeLine(`[contexto resumido: ${compacted.reason}]`);
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

async function askModel(state, model, prompt, options = {}) {
  if (!options.skipCompact) {
    const compacted = core.maybeCompactConversation(state, prompt);
    printCompactionNotice(compacted);
  }

  state.contextBlock = await core.buildContextBlock(state);
  const messages = buildMessages(state, prompt);
  return lmstudio.chatCompletion(state.options.baseUrl, model, messages);
}

function recordConversationTurn(state, prompt, answer) {
  if (!answer) {
    return;
  }

  state.history.push({ role: "user", content: prompt });
  state.history.push({ role: "assistant", content: answer });
}

function applyModelSelection(state, selected, successMessage) {
  state.contextWindowTokens = selected.contextLength || state.contextWindowTokens;
  state.history = [];
  state.summary = "";
  state.expandedFiles.clear();
  state.fileContextBudgets.clear();
  ui.writeLine(successMessage(selected.key));
}

function printFiles(state, filter = "") {
  const result = core.listFiles(state, filter);
  if (!result.files.length) {
    ui.writeLine("No se encontraron archivos.");
    return;
  }

  result.preview.forEach((filePath) => ui.writeLine(filePath));
  if (result.hiddenCount > 0) {
    ui.writeLine(`[+${result.hiddenCount} archivos mas]`);
  }
}

async function printReadFile(state, query) {
  const result = await core.readFileContent(state, query);
  if (result.error) {
    ui.errorLine(result.error);
    if (result.matches) {
      result.matches.forEach((filePath) => ui.errorLine(filePath));
    }
    return;
  }

  ui.writeLine(result.content);
}

async function runOneShot(state, model, prompt) {
  const result = await runAgentLoop(state, model, prompt, ui);
  recordConversationTurn(state, prompt, result.finalText || result.rawAnswer);
}

async function runInteractive(state, model) {
  ui.printStartupBanner(state, model);

  while (true) {
    const input = await ui.readFancyInput(state, model);

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
        ui.writeLine(
          "/models  /model  /model <id>  /load  /load <id>  /files [filtro]  /add <ruta>  /drop <ruta>  /context  /read <ruta>  /run <cmd>  /patch <inst>  /apply <inst>  /summary  /compact  /clear  /reset  /exit"
        );
        continue;
      }

      if (input === "/models") {
        lmstudio.printModels(ui, await lmstudio.fetchModels(state.options.baseUrl));
        continue;
      }

      if (input.startsWith("/model ")) {
        const selected = await lmstudio.switchModel(
          state.options.baseUrl,
          model,
          input.slice(7).trim(),
          false,
          ui
        );
        model = selected.key;
        applyModelSelection(state, selected, (key) => `Modelo cambiado a ${key}`);
        continue;
      }

      if (input === "/model" || input === "/load") {
        const selected = await lmstudio.switchModel(state.options.baseUrl, model, "", true, ui, true);
        model = selected.key;
        applyModelSelection(state, selected, (key) => `Modelo activo: ${key}`);
        continue;
      }

      if (input.startsWith("/load ")) {
        const selected = await lmstudio.switchModel(
          state.options.baseUrl,
          model,
          input.slice(6).trim(),
          false,
          ui
        );
        model = selected.key;
        applyModelSelection(state, selected, (key) => `Modelo activo: ${key}`);
        continue;
      }

      if (input === "/clear") {
        state.history = [];
        state.summary = "";
        state.expandedFiles.clear();
        ui.writeLine("Conversacion limpiada.");
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
        ui.writeLine("Contexto reiniciado.");
        continue;
      }

      if (input === "/summary") {
        if (!state.summary) {
          ui.writeLine("No hay resumen acumulado todavia.");
        } else {
          ui.writeLine(state.summary);
        }
        continue;
      }

      if (input === "/compact") {
        const compacted = core.compactConversation(state, "manual");
        if (!compacted) {
          ui.writeLine("No habia historial para resumir.");
        } else {
          printCompactionNotice(compacted);
        }
        continue;
      }

      if (input.startsWith("/files")) {
        printFiles(state, input.slice(6));
        continue;
      }

      if (input.startsWith("/add ")) {
        const { added, warnings } = core.addFiles(state, [input.slice(5).trim()], "manual");
        warnings.forEach((warning) => ui.errorLine(warning));
        if (added.length) {
          ui.writeLine(`Agregados:\n${added.join("\n")}`);
        }
        continue;
      }

      if (input.startsWith("/drop ")) {
        const { removed, warnings } = core.dropFiles(state, [input.slice(6).trim()]);
        warnings.forEach((warning) => ui.errorLine(warning));
        if (removed.length) {
          ui.writeLine(`Quitados:\n${removed.join("\n")}`);
        }
        continue;
      }

      if (input === "/context") {
        ui.writeLine(core.getContextSummary(state));
        continue;
      }

      if (input.startsWith("/read ")) {
        await printReadFile(state, input.slice(6).trim());
        continue;
      }

      if (input.startsWith("/run ")) {
        const result = core.runShellCommand(state, input.slice(5).trim());
        ui.writeLine(result.output);
        continue;
      }

      if (input.startsWith("/patch ")) {
        await previewPatch(state, model, input.slice(7).trim(), { askModel, ui });
        continue;
      }

      if (input.startsWith("/apply ")) {
        await applyChanges(state, model, input.slice(7).trim(), { askModel, ui });
        continue;
      }

      const result = await runAgentLoop(state, model, input, ui);
      recordConversationTurn(state, input, result.finalText || result.rawAnswer);
    } catch (error) {
      ui.errorLine(error instanceof Error ? error.message : String(error));
    }
  }
}

async function main() {
  const options = parseArgs(argv.slice(2));

  if (options.help) {
    printHelp(ui.write);
    return;
  }

  const state = core.createState(options);

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
    await runOneShot(state, model, prompt);
    return;
  }

  await runInteractive(state, model);
}

module.exports = {
  main,
};

if (require.main === module) {
  main().catch((error) => {
    ui.errorLine(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
