const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const core = require("./core");
const lmstudio = require("./lmstudio");
const { applyFileBlocks, parseApplyBlocks } = require("./apply");

const MAX_AGENT_STEPS = 10;
const MAX_TOOL_RESULT_BYTES = 12 * 1024;

const AGENT_PROTOCOL = [
  "Actua como un agente local de programacion al estilo Codex o Claude Code.",
  "Trabaja de forma autonoma sobre el proyecto actual.",
  "Puedes inspeccionar archivos, buscar texto, ejecutar comandos seguros y escribir archivos.",
  "No le pidas al usuario que agregue archivos manualmente si puedes descubrirlos tu.",
  "En cada turno responde con EXACTAMENTE una sola familia de accion.",
  "",
  "Acciones permitidas:",
  "<<<READ:ruta/o/filtro>>>",
  "Puedes devolver varias lineas READ en la misma respuesta.",
  "",
  "<<<LIST:filtro opcional>>>",
  "",
  "<<<GREP:texto fijo a buscar>>>",
  "",
  "<<<RUN:comando>>>",
  "",
  "<<<DELETE:ruta/relativa>>>",
  "Puedes devolver varias lineas DELETE en la misma respuesta.",
  "",
  "<<<FILE:ruta/relativa>>>",
  "<contenido completo del archivo>",
  "<<<END FILE>>>",
  "Puedes devolver varios bloques FILE en la misma respuesta.",
  "",
  "<<<FINAL>>>",
  "respuesta final en texto plano para consola",
  "<<<END FINAL>>>",
  "",
  "Reglas estrictas:",
  "- No uses markdown ni fences.",
  "- Si necesitas leer, usa READ.",
  "- Si no conoces la ruta, usa LIST o GREP.",
  "- Si haces cambios, devuelve bloques FILE con contenido completo.",
  "- Cuando termines, usa FINAL.",
  "- No mezcles READ/LIST/GREP/RUN/DELETE/FILE/FINAL en una misma respuesta.",
  "- No inventes resultados de herramientas.",
].join("\n");

function buildAgentMessages(state, userPrompt, trace) {
  const recentHistory = state.history.slice(-10);
  const messages = [
    { role: "system", content: state.options.systemPrompt },
    { role: "system", content: AGENT_PROTOCOL },
    {
      role: "system",
      content: `Contexto del proyecto actual:\n${state.contextBlock}`,
    },
    ...recentHistory,
    { role: "user", content: userPrompt },
  ];

  for (const step of trace) {
    messages.push({ role: "assistant", content: step.assistant });
    messages.push({
      role: "user",
      content: `RESULTADO_HERRAMIENTA:\n${step.result}`,
    });
  }

  return messages;
}

function parseTaggedValues(text, tag, allowEmpty = false) {
  const regex = new RegExp(`<<<${tag}(?::([\\s\\S]*?))?>>>`, "g");
  const values = [];
  let match = regex.exec(text);

  while (match) {
    values.push((match[1] || "").trim());
    match = regex.exec(text);
  }

  if (values.length === 0) {
    const prefix = `<<<${tag}`;
    const lines = String(text || "").split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith(prefix)) {
        continue;
      }

      const closingMatch = line.match(/>+$/);
      if (!closingMatch) {
        continue;
      }

      const body = line.slice(prefix.length, line.length - closingMatch[0].length);
      if (body && !body.startsWith(":")) {
        continue;
      }

      values.push((body.startsWith(":") ? body.slice(1) : "").trim());
    }
  }

  return allowEmpty ? values : values.filter((value) => value.length > 0);
}

function stripLinePrefix(line) {
  return String(line || "")
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function parsePlainActionLines(text, keywords, options = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => stripLinePrefix(line))
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const keywordPattern = keywords
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(`^(?:${keywordPattern})(?:\\s*:)?(?:\\s+(.*)|\\s*:\\s*(.*))?$`, "i");
  const values = [];

  for (const line of lines) {
    const match = line.match(regex);
    if (!match) {
      return [];
    }

    values.push((match[1] || match[2] || "").trim());
  }

  if (options.allowEmpty) {
    return values;
  }

  return values.filter((value) => value.length > 0);
}

function parsePlainFileBlocks(text) {
  const regex =
    /(?:^|\n)\s*(?:FILE|ARCHIVO)\s*:\s*(.+?)\r?\n([\s\S]*?)(?:\r?\n\s*)?(?:END FILE|FIN ARCHIVO)\s*(?=\n|$)/gi;
  const files = [];
  let match = regex.exec(text);

  while (match) {
    files.push({
      relativePath: match[1].trim(),
      content: match[2].replace(/\s+$/, ""),
    });
    match = regex.exec(text);
  }

  return files;
}

function parseFinalBlock(text) {
  const match = text.match(/<<<FINAL>>>\r?\n?([\s\S]*?)\r?\n?<<<END FINAL>>>/);
  if (match) {
    return match[1].trim();
  }

  const lines = String(text || "").split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^<<<FINAL>+\s*$/.test(line.trim()));
  if (startIndex === -1) {
    return "";
  }

  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && /^<<<END FINAL>+\s*$/.test(line.trim())
  );
  if (endIndex === -1) {
    return "";
  }

  return lines.slice(startIndex + 1, endIndex).join("\n").trim();
}

function parseAgentResponse(state, text, sanitizeConsoleResponse) {
  const taggedReads = parseTaggedValues(text, "READ");
  const taggedLists = parseTaggedValues(text, "LIST", true);
  const taggedGreps = parseTaggedValues(text, "GREP");
  const taggedRuns = parseTaggedValues(text, "RUN");
  const taggedDeletes = parseTaggedValues(text, "DELETE");
  const taggedFileBlocks = parseApplyBlocks(text);
  const taggedFinalText = parseFinalBlock(text);

  const plainReads = parsePlainActionLines(text, ["READ", "LEER", "LEE"]);
  const plainLists = parsePlainActionLines(text, ["LIST", "LISTAR", "LISTA"], {
    allowEmpty: true,
  });
  const plainGreps = parsePlainActionLines(text, ["GREP", "SEARCH", "BUSCAR", "BUSCA"]);
  const plainRuns = parsePlainActionLines(text, [
    "RUN",
    "CMD",
    "COMMAND",
    "COMANDO",
    "EJECUTAR",
    "EJECUTA",
  ]);
  const plainDeletes = parsePlainActionLines(text, [
    "DELETE",
    "REMOVE",
    "REMOVER",
    "BORRAR",
    "BORRA",
  ]);
  const plainFileBlocks = parsePlainFileBlocks(text);
  const plainFinalText =
    String(text || "").match(/^\s*(?:FINAL|RESPUESTA FINAL)\s*:\s*([\s\S]*)$/i)?.[1]?.trim() || "";

  const reads = taggedReads.length > 0 ? taggedReads : plainReads;
  const lists = taggedLists.length > 0 ? taggedLists : plainLists;
  const greps = taggedGreps.length > 0 ? taggedGreps : plainGreps;
  const runs = taggedRuns.length > 0 ? taggedRuns : plainRuns;
  const deletes = taggedDeletes.length > 0 ? taggedDeletes : plainDeletes;
  const fileBlocks = taggedFileBlocks.length > 0 ? taggedFileBlocks : plainFileBlocks;
  const finalText = taggedFinalText || plainFinalText;

  const present = [
    reads.length > 0 ? "read" : null,
    lists.length > 0 ? "list" : null,
    greps.length > 0 ? "grep" : null,
    runs.length > 0 ? "run" : null,
    deletes.length > 0 ? "delete" : null,
    fileBlocks.length > 0 ? "write" : null,
    finalText ? "final" : null,
  ].filter(Boolean);

  if (new Set(present).size > 1) {
    return {
      type: "invalid",
      message:
        "Respuesta invalida: usa una sola accion por turno. Ejemplos validos: <<<READ:src/app.js>>>, RUN npm test, FINAL: listo.",
    };
  }

  if (reads.length > 0) {
    return { type: "read", paths: [...new Set(reads)] };
  }

  if (lists.length > 0) {
    return { type: "list", filter: lists[0] };
  }

  if (greps.length > 0) {
    return { type: "grep", query: greps[0] };
  }

  if (runs.length > 0) {
    return { type: "run", command: runs[0] };
  }

  if (deletes.length > 0) {
    return { type: "delete", paths: [...new Set(deletes)] };
  }

  if (fileBlocks.length > 0) {
    return { type: "write", files: fileBlocks };
  }

  if (finalText) {
    return { type: "final", content: finalText };
  }

  return {
    type: "final",
    content: sanitizeConsoleResponse(text),
  };
}

function isDangerousCommand(command) {
  const normalized = String(command || "").trim().toLowerCase();
  return [
    /\brm\b/,
    /\brmdir\b/,
    /\bdel\b/,
    /\bmv\b/,
    /\bsudo\b/,
    /\bdoas\b/,
    /\bpkexec\b/,
    /\bsu\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bgit\s+reset\b/,
    /\bgit\s+checkout\s+--\b/,
    /\bgit\s+clean\b/,
    /\bfind\b[\s\S]*\b-delete\b/,
    /\b(?:sh|bash|zsh|fish)\s+-c\b/,
    /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|fish)\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bdd\b/,
    /\bmkfs\b/,
  ].some((pattern) => pattern.test(normalized));
}

async function confirmAction(ui, prompt) {
  const answer = (await ui.askPlainQuestion(`${prompt} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes" || answer === "si" || answer === "s";
}

function formatToolResult(title, body) {
  const composed = `${title}\n${body}`.trim();
  return core.truncateText(composed, MAX_TOOL_RESULT_BYTES).text;
}

async function executeRead(state, paths) {
  const output = [];
  const mode = state.selectionMode === "manual" ? "manual" : "auto";

  for (const request of paths) {
    const result = core.resolveFileQuery(state, request);
    if (result.error) {
      output.push(`[error] ${result.error}`);
      continue;
    }

    const matches = result.matches.slice(0, 3);
    if (result.matches.length > 3) {
      output.push(
        `[warning] "${request}" coincide con ${result.matches.length} archivos. Leyendo solo 3.`
      );
    }

    core.addFiles(state, matches, mode);
    for (const relativePath of matches) {
      const { text } = await core.readFileForContext(state.rootDir, relativePath, 12 * 1024);
      output.push(`--- FILE: ${relativePath} ---`);
      output.push(text);
    }
  }

  return formatToolResult("READ_OK", output.join("\n"));
}

function executeList(state, filter) {
  const result = core.listFiles(state, filter || "");
  if (!result.files.length) {
    return formatToolResult("LIST_OK", "[sin resultados]");
  }

  const lines = [...result.preview];
  if (result.hiddenCount > 0) {
    lines.push(`[+${result.hiddenCount} archivos mas]`);
  }
  return formatToolResult("LIST_OK", lines.join("\n"));
}

function executeGrep(state, query) {
  const result = core.searchProjectContent(state, query, { maxResults: 40 });
  if (result.error) {
    return formatToolResult("GREP_ERROR", result.error);
  }

  const lines = [...result.matches];
  if (result.hiddenCount > 0) {
    lines.push(`[+${result.hiddenCount} coincidencias mas]`);
  }
  return formatToolResult("GREP_OK", lines.join("\n") || "[sin resultados]");
}

async function executeRun(state, command, ui) {
  const normalizedCommand = String(command || "").trim();

  if (!normalizedCommand) {
    return formatToolResult("RUN_ERROR", "El comando no puede estar vacio.");
  }

  if (!core.canRunCommands(state)) {
    return formatToolResult("RUN_DENIED", "El modo read-only no permite ejecutar comandos.");
  }

  if (isDangerousCommand(normalizedCommand) && !core.skipsPermissionPrompts(state)) {
    const allowed = await confirmAction(
      ui,
      `Permitir comando potencialmente peligroso: ${normalizedCommand}`
    );
    if (!allowed) {
      return formatToolResult(
        "RUN_CANCELLED",
        "El usuario no aprobo el comando. Finaliza sin volver a pedir confirmacion."
      );
    }
  }

  const result = core.runShellCommand(state, normalizedCommand);
  return formatToolResult(`RUN_OK status=${result.status ?? "?"}`, result.output);
}

async function executeDelete(state, paths, ui) {
  if (!core.canWriteWorkspace(state)) {
    return formatToolResult("DELETE_DENIED", "El modo read-only no permite borrar archivos.");
  }

  const safePaths = paths.filter((relativePath) => core.isSafeProjectEditPath(relativePath));
  if (!safePaths.length) {
    return formatToolResult("DELETE_ERROR", "No hay rutas seguras para borrar.");
  }

  if (!core.skipsPermissionPrompts(state)) {
    const allowed = await confirmAction(ui, `Permitir borrado de ${safePaths.join(", ")}`);
    if (!allowed) {
      return formatToolResult(
        "DELETE_CANCELLED",
        "El usuario no aprobo el borrado. Finaliza sin volver a pedir confirmacion."
      );
    }
  }

  const deleted = [];
  const errors = [];

  for (const relativePath of safePaths) {
    try {
      const absolute = path.join(state.rootDir, relativePath);
      const stats = await fsp.stat(absolute);
      if (!stats.isFile()) {
        errors.push(`${relativePath}: no es un archivo regular`);
        continue;
      }

      await fsp.unlink(absolute);
      deleted.push(relativePath);
    } catch (error) {
      errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const remainingSelection = [...state.selectedFiles].filter((filePath) => !deleted.includes(filePath));
  core.replaceSelectedFiles(
    state,
    remainingSelection,
    state.selectionMode === "manual" ? "manual" : remainingSelection.length ? "auto" : "none"
  );
  core.refreshProjectSnapshot(state);

  return formatToolResult(
    "DELETE_OK",
    [
      deleted.length > 0 ? `borrados:\n${deleted.join("\n")}` : "",
      errors.length > 0 ? `errores:\n${errors.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}

async function executeWrite(state, files, ui) {
  if (!core.canWriteWorkspace(state)) {
    return formatToolResult("WRITE_DENIED", "El modo read-only no permite modificar archivos.");
  }

  const result = await applyFileBlocks(state, files, ui, { autoConfirm: true });
  return formatToolResult(
    result.applied ? "WRITE_OK" : "WRITE_NOOP",
    result.writtenFiles.length > 0 ? result.writtenFiles.join("\n") : "[sin cambios]"
  );
}

async function executeAction(state, action, ui) {
  switch (action.type) {
    case "read":
      ui.writeLine(`${ui.paint("agent:", ui.theme.dim)} leyendo ${action.paths.join(", ")}`);
      return executeRead(state, action.paths);
    case "list":
      ui.writeLine(
        `${ui.paint("agent:", ui.theme.dim)} listando archivos${action.filter ? ` (${action.filter})` : ""}`
      );
      return executeList(state, action.filter);
    case "grep":
      ui.writeLine(`${ui.paint("agent:", ui.theme.dim)} buscando "${action.query}"`);
      return executeGrep(state, action.query);
    case "run":
      ui.writeLine(`${ui.paint("agent:", ui.theme.dim)} ejecutando ${action.command}`);
      return executeRun(state, action.command, ui);
    case "delete":
      ui.writeLine(`${ui.paint("agent:", ui.theme.dim)} solicitando borrado ${action.paths.join(", ")}`);
      return executeDelete(state, action.paths, ui);
    case "write":
      ui.writeLine(`${ui.paint("agent:", ui.theme.dim)} aplicando cambios en archivos`);
      return executeWrite(state, action.files, ui);
    case "invalid":
      return formatToolResult("TOOL_ERROR", action.message);
    default:
      return formatToolResult("TOOL_ERROR", `Accion no soportada: ${action.type}`);
  }
}

async function requestAgentAction(state, model, userPrompt, trace, ui, options = {}) {
  if (!options.skipCompact) {
    const compacted = core.maybeCompactConversation(state, userPrompt);
    if (compacted) {
      ui.writeLine(`[contexto resumido: ${compacted.reason}]`);
    }
  }

  state.contextBlock = await core.buildContextBlock(state);
  const messages = buildAgentMessages(state, userPrompt, trace);
  return ui.runWithSpinner(model, options.label || "agente", () =>
    lmstudio.chatCompletion(state.options.baseUrl, model, messages)
  );
}

async function runAgentLoop(state, model, userPrompt, ui) {
  const trace = [];
  let rawResponse = await requestAgentAction(state, model, userPrompt, trace, ui, {
    label: "agente",
  });

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    const action = parseAgentResponse(state, rawResponse, ui.sanitizeConsoleResponse);
    if (action.type === "final") {
      const finalText = ui.sanitizeConsoleResponse(action.content || rawResponse);
      if (finalText) {
        ui.writeLine(finalText);
      }
      return {
        finalText,
        rawAnswer: rawResponse.trim(),
      };
    }

    const result = await executeAction(state, action, ui);
    trace.push({ assistant: rawResponse, result });
    rawResponse = await requestAgentAction(state, model, userPrompt, trace, ui, {
      skipCompact: true,
      label: `agente paso ${step + 2}`,
    });
  }

  const forcedTrace = [
    ...trace,
    {
      assistant: rawResponse,
      result:
        "TOOL_ERROR\nLlegaste al maximo de pasos. Debes cerrar con <<<FINAL>>> usando el contexto disponible.",
    },
  ];
  const forcedFinal = await requestAgentAction(state, model, userPrompt, forcedTrace, ui, {
    skipCompact: true,
    label: "cerrando",
  });
  const finalText = ui.sanitizeConsoleResponse(parseFinalBlock(forcedFinal) || forcedFinal);
  if (finalText) {
    ui.writeLine(finalText);
  }
  return {
    finalText,
    rawAnswer: forcedFinal.trim(),
  };
}

module.exports = {
  isDangerousCommand,
  parseAgentResponse,
  runAgentLoop,
};
