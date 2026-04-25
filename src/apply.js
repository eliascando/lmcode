const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { APPLY_MAX_PASSES, MAX_READ_REQUESTS } = require("./config");
const {
  bumpFileContextBudget,
  canWriteWorkspace,
  isSafeProjectEditPath,
  pickAutoContextFiles,
  refreshProjectSnapshot,
  replaceSelectedFiles,
  resolveFileQuery,
  runCapture,
  toPosixPath,
} = require("./core");

function buildPatchPrompt(state, instruction) {
  const fileList = [...state.selectedFiles].sort().join("\n");
  return [
    "Tarea de programacion sobre archivos seleccionados.",
    "Archivos permitidos:",
    fileList,
    "",
    `Instruccion: ${instruction}`,
    "",
    "Devuelve SOLO un diff unificado valido.",
    "No uses bloques markdown.",
    "No agregues explicaciones.",
  ].join("\n");
}

function buildApplyPrompt(state, instruction, options = {}) {
  const fileList = [...state.selectedFiles].sort().join("\n") || "[sin archivos precargados]";
  const lines = [
    "Tarea de programacion sobre archivos seleccionados.",
    "Archivos actuales en contexto:",
    fileList,
    "",
    `Instruccion: ${instruction}`,
    "",
    "Si te falta contexto, no expliques nada y devuelve SOLO lineas con este formato:",
    "<<<READ:ruta/relativa>>>",
    `Maximo ${MAX_READ_REQUESTS} rutas.`,
    "",
    "Devuelve SOLO los archivos modificados con este formato exacto:",
    "<<<FILE:ruta/relativa>>>",
    "<contenido completo del archivo>",
    "<<<END FILE>>>",
    "",
    "No uses markdown.",
    "No agregues comentarios.",
    "Puedes crear archivos nuevos si hace falta.",
    "Nunca le pidas al usuario que use /add.",
  ];

  if (state.selectedFiles.size === 1) {
    lines.push(
      "",
      `Si solo necesitas modificar un archivo, devuelve ese archivo completo: ${[
        ...state.selectedFiles,
      ][0]}`
    );
  }

  if (options.forceFileOutput) {
    lines.push(
      "",
      "Ya tienes el contexto maximo disponible.",
      "No devuelvas <<<READ>>>.",
      "Devuelve SOLO bloques <<<FILE>>>."
    );
  }

  return lines.join("\n");
}

function parseApplyBlocks(text) {
  const regex = /(?:^|\n)\s*<<<FILE:(.+?)>+\r?\n([\s\S]*?)(?:\r?\n\s*)?<<<END FILE>+\s*(?=\n|$)/g;
  const files = [];
  let match = regex.exec(text);

  while (match) {
    files.push({
      relativePath: match[1].trim(),
      content: match[2],
    });
    match = regex.exec(text);
  }

  return files;
}

function looksLikeSourceCode(text, relativePath = "") {
  const sample = String(text || "").trim();
  if (!sample) {
    return false;
  }

  const lines = sample.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 5) {
    return false;
  }

  const ext = path.posix.extname(relativePath).toLowerCase();
  const strongPatterns = [
    /^\s*import\b/m,
    /^\s*export\b/m,
    /^\s*function\b/m,
    /^\s*(const|let|var)\b/m,
    /^\s*class\b/m,
    /=>\s*[{(<]/,
    /<\/?[A-Z][A-Za-z0-9]*/,
    /<\/?[a-z][A-Za-z0-9-]*/,
    /^\s*return\b/m,
  ];

  if (ext === ".json") {
    return /^[\[{]/.test(sample);
  }

  return strongPatterns.some((pattern) => pattern.test(sample));
}

function parseSingleFileCodeFenceFallback(state, text) {
  if (state.selectedFiles.size !== 1) {
    return [];
  }

  const relativePath = [...state.selectedFiles][0];
  const regex = /```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g;
  let best = "";
  let match = regex.exec(text);

  while (match) {
    const candidate = match[1] || "";
    if (candidate.trim().length > best.trim().length) {
      best = candidate;
    }
    match = regex.exec(text);
  }

  if (!best.trim() || !looksLikeSourceCode(best, relativePath)) {
    return [];
  }

  return [
    {
      relativePath,
      content: best.replace(/\s+$/, ""),
    },
  ];
}

function extractApplyBlocks(state, text) {
  const explicitBlocks = parseApplyBlocks(text);
  if (explicitBlocks.length > 0) {
    return explicitBlocks;
  }

  return parseSingleFileCodeFenceFallback(state, text);
}

function parseReadRequests(text) {
  const regex = /(?:^|\n)\s*<<<READ:(.+?)>+\s*(?=\n|$)/g;
  const requests = [];
  let match = regex.exec(text);

  while (match) {
    requests.push(match[1].trim());
    match = regex.exec(text);
  }

  return [...new Set(requests)].slice(0, MAX_READ_REQUESTS);
}

async function diffText(oldText, newText, relativePath) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lmcode-"));
  const beforePath = path.join(tmpDir, "before");
  const afterPath = path.join(tmpDir, "after");

  try {
    await fsp.writeFile(beforePath, oldText, "utf8");
    await fsp.writeFile(afterPath, newText, "utf8");

    const result = runCapture("diff", [
      "-u",
      "-L",
      `a/${relativePath}`,
      "-L",
      `b/${relativePath}`,
      beforePath,
      afterPath,
    ]);
    return result.stdout || result.stderr || "";
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

function addRequestedFilesToContext(state, requests) {
  const added = [];
  const warnings = [];

  for (const request of requests) {
    if (!request) {
      continue;
    }

    const normalizedRequest = toPosixPath(request.trim());
    const absolute = path.join(state.rootDir, normalizedRequest);

    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      const alreadySelected = state.selectedFiles.has(normalizedRequest);
      state.selectedFiles.add(normalizedRequest);
      const didGrow = bumpFileContextBudget(state, normalizedRequest);
      if (!alreadySelected || didGrow) {
        added.push(normalizedRequest);
      }
      continue;
    }

    const result = resolveFileQuery(state, request);
    if (result.error) {
      warnings.push(result.error);
      continue;
    }

    for (const match of result.matches.slice(0, 2)) {
      const alreadySelected = state.selectedFiles.has(match);
      state.selectedFiles.add(match);
      const didGrow = bumpFileContextBudget(state, match);
      if (!alreadySelected || didGrow) {
        added.push(match);
      }
    }
  }

  return {
    added: [...new Set(added)],
    warnings,
  };
}

async function applyFileBlocks(state, blocks, ui, options = {}) {
  if (!canWriteWorkspace(state)) {
    ui.errorLine("El modo read-only no permite modificar archivos.");
    return {
      applied: false,
      writtenFiles: [],
    };
  }

  const diffs = [];
  const pendingWrites = [];

  for (const block of blocks) {
    const relativePath = toPosixPath(block.relativePath);
    if (!isSafeProjectEditPath(relativePath)) {
      ui.errorLine(`Ignorando ruta insegura: ${relativePath}`);
      continue;
    }

    const absolute = path.join(state.rootDir, relativePath);
    const exists = fs.existsSync(absolute);
    const current = exists ? await fsp.readFile(absolute, "utf8") : "";
    if (current === block.content) {
      continue;
    }

    const diff = await diffText(current, block.content, relativePath);
    diffs.push(diff || `Cambios en ${relativePath}\n`);
    pendingWrites.push({ absolute, relativePath, content: block.content });
  }

  if (!pendingWrites.length) {
    ui.writeLine("No hay cambios para aplicar.");
    return {
      applied: false,
      writtenFiles: [],
    };
  }

  ui.write(diffs.join("\n"));
  if (!options.autoConfirm) {
    const answer = (await ui.askPlainQuestion("Aplicar cambios? [y/N]: "))
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes" && answer !== "si" && answer !== "s") {
      ui.writeLine("Cambios cancelados.");
      return {
        applied: false,
        writtenFiles: [],
      };
    }
  }

  for (const item of pendingWrites) {
    await fsp.mkdir(path.dirname(item.absolute), { recursive: true });
    await fsp.writeFile(item.absolute, item.content, "utf8");
  }

  const nextSelection = new Set([
    ...state.selectedFiles,
    ...pendingWrites.map((item) => item.relativePath),
  ]);
  replaceSelectedFiles(
    state,
    nextSelection,
    state.selectionMode === "manual" ? "manual" : "auto"
  );
  refreshProjectSnapshot(state);

  ui.writeLine(`Cambios aplicados en ${pendingWrites.length} archivo(s).`);
  return {
    applied: true,
    writtenFiles: pendingWrites.map((item) => item.relativePath),
  };
}

async function previewPatch(state, model, instruction, deps) {
  const { askModel, ui } = deps;

  if (state.selectedFiles.size === 0) {
    ui.errorLine("Agrega archivos con /add antes de pedir un patch.");
    return;
  }

  const patch = await askModel(state, model, buildPatchPrompt(state, instruction));
  ui.writeLine(patch);
}

async function applyChanges(state, model, instruction, deps, options = {}) {
  const { askModel, ui } = deps;

  if (!canWriteWorkspace(state)) {
    ui.errorLine("El modo read-only no permite modificar archivos.");
    return false;
  }

  if (state.selectedFiles.size === 0) {
    const autoFiles = pickAutoContextFiles(state, instruction);
    if (!autoFiles.length) {
      ui.errorLine("No pude detectar archivos relevantes para aplicar cambios.");
      return false;
    }

    replaceSelectedFiles(state, autoFiles, "auto");
    ui.writeLine(`${ui.paint("Contexto detectado:", ui.theme.dim)} ${autoFiles.join(", ")}`);
  }

  let response = "";
  let blocks = [];
  let pass = 0;
  let forceFileOutput = false;
  let lastReadRequests = [];

  while (pass < APPLY_MAX_PASSES) {
    response = await ui.runWithSpinner(model, "preparando cambios", () =>
      askModel(state, model, buildApplyPrompt(state, instruction, { forceFileOutput }))
    );
    blocks = extractApplyBlocks(state, response);

    if (blocks.length > 0) {
      break;
    }

    const readRequests = parseReadRequests(response);
    lastReadRequests = readRequests;

    if (!readRequests.length) {
      if (!forceFileOutput && state.selectedFiles.size > 0) {
        forceFileOutput = true;
        pass += 1;
        continue;
      }

      break;
    }

    const { added, warnings } = addRequestedFilesToContext(state, readRequests);
    warnings.forEach((warning) => ui.errorLine(warning));

    if (added.length > 0) {
      ui.writeLine(`${ui.paint("Leyendo contexto adicional:", ui.theme.dim)} ${added.join(", ")}`);
      pass += 1;
      continue;
    }

    if (!forceFileOutput) {
      ui.writeLine(
        ui.paint(
          "Contexto ya ampliado al maximo; forzando propuesta con lo disponible.",
          ui.theme.dim
        )
      );
      forceFileOutput = true;
      pass += 1;
      continue;
    }

    break;
  }

  if (!blocks.length) {
    if (lastReadRequests.length > 0) {
      ui.errorLine(
        "El modelo siguio pidiendo mas lectura del mismo contexto y no devolvio archivos editables."
      );
    } else {
      ui.errorLine("No pude extraer cambios aplicables de la respuesta del modelo.");
    }

    if (!options.silentOnFailure) {
      const cleaned = ui.sanitizeConsoleResponse(response);
      if (cleaned) {
        ui.writeLine(cleaned);
      }
    }

    return false;
  }

  const result = await applyFileBlocks(state, blocks, ui, options);
  return result.applied;
}

module.exports = {
  applyFileBlocks,
  applyChanges,
  extractApplyBlocks,
  parseApplyBlocks,
  previewPatch,
};
