const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cwd } = require("node:process");

const {
  AUTO_CONTEXT_MAX_FILES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  ESTIMATED_BYTES_PER_TOKEN,
  FILE_CONTEXT_LEVELS,
  HISTORY_COMPACT_TRIGGER_BYTES,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PREVIEW,
  MAX_GIT_STATUS_LINES,
  MAX_HISTORY_MESSAGES,
  MAX_REPO_MAP_FILES,
  MAX_TOTAL_FILE_BYTES,
  PERMISSION_MODES,
  SUMMARY_MAX_BYTES,
} = require("./config");

function runCapture(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: options.shell || false,
  });
}

function commandExists(command) {
  const result = runCapture("which", [command]);
  return result.status === 0;
}

function detectProjectRoot(startDir) {
  const git = runCapture("git", ["rev-parse", "--show-toplevel"], { cwd: startDir });
  if (git.status === 0) {
    return {
      rootDir: git.stdout.trim(),
      isGitRepo: true,
    };
  }

  return {
    rootDir: startDir,
    isGitRepo: false,
  };
}

function toPosixPath(input) {
  return input.split(path.sep).join("/");
}

function truncateText(text, maxBytes) {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  let slice = text;
  while (Buffer.byteLength(slice, "utf8") > maxBytes) {
    slice = slice.slice(0, Math.max(0, slice.length - 256));
  }

  return {
    text: `${slice}\n\n[truncado]`,
    truncated: true,
  };
}

function truncateInline(text, maxWidth) {
  if (text.length <= maxWidth) {
    return text;
  }

  if (maxWidth <= 1) {
    return text.slice(0, maxWidth);
  }

  return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function padInline(text, width) {
  return text + " ".repeat(Math.max(0, width - text.length));
}

function formatBytes(bytes) {
  if (bytes >= 1024) {
    const value = bytes / 1024;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function displayPath(inputPath) {
  const homeDir = process.env.HOME || os.homedir();
  const absolute = path.resolve(inputPath);

  if (absolute === homeDir) {
    return "~";
  }

  if (absolute.startsWith(`${homeDir}${path.sep}`)) {
    return `~/${toPosixPath(path.relative(homeDir, absolute))}`;
  }

  return absolute;
}

function normalizeSearchText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractSearchTokens(prompt) {
  const stopwords = new Set([
    "para",
    "que",
    "con",
    "sin",
    "una",
    "uno",
    "unos",
    "unas",
    "este",
    "esta",
    "estos",
    "estas",
    "hacer",
    "hacerlo",
    "como",
    "quiero",
    "tengo",
    "necesito",
    "solo",
    "pero",
    "porque",
    "donde",
    "desde",
    "hasta",
    "sobre",
    "tabla",
    "switch",
    "toggle",
    "that",
    "with",
    "from",
    "this",
  ]);

  return [
    ...new Set(
      normalizeSearchText(prompt)
        .split(/[^a-z0-9_./-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !stopwords.has(token))
    ),
  ];
}

function looksLikeEditRequest(prompt) {
  const normalized = normalizeSearchText(prompt);
  const editHints = [
    "cambia",
    "cambiar",
    "modifica",
    "modificar",
    "actualiza",
    "actualizar",
    "arregla",
    "corrige",
    "implementa",
    "implement",
    "agrega",
    "agregar",
    "crea",
    "crear",
    "programa",
    "refactor",
    "quita",
    "remueve",
    "desactiva",
    "activa",
    "ajusta",
    "editar",
    "edita",
    "fix",
    "change",
    "update",
    "remove",
    "add",
  ];

  return editHints.some((hint) => normalized.includes(hint));
}

function listProjectFiles(rootDir) {
  if (commandExists("rg")) {
    const rg = runCapture("rg", ["--files"], { cwd: rootDir });
    if (rg.status === 0) {
      return rg.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
    }
  }

  const files = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".dart_tool" ||
        entry.name === ".next" ||
        entry.name === ".Trash"
      ) {
        continue;
      }

      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (entry.isFile()) {
        files.push(toPosixPath(path.relative(rootDir, absolute)));
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

function getGitStatus(rootDir) {
  const git = runCapture("git", ["status", "--short"], { cwd: rootDir });
  if (git.status !== 0) {
    return "";
  }

  return git.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, MAX_GIT_STATUS_LINES)
    .join("\n");
}

function refreshProjectSnapshot(state) {
  const homeDir = process.env.HOME || "";
  const shouldIndexProject = state.isGitRepo || state.rootDir !== homeDir;
  state.projectFiles = shouldIndexProject ? listProjectFiles(state.rootDir) : [];
  state.gitStatus = state.isGitRepo ? getGitStatus(state.rootDir) : "";
  return state;
}

function normalizePermissionMode(mode) {
  const candidate = String(mode || "").trim().toLowerCase();
  return PERMISSION_MODES.includes(candidate) ? candidate : DEFAULT_PERMISSION_MODE;
}

function getPermissionMode(state) {
  return normalizePermissionMode(state?.options?.permissionMode);
}

function canWriteWorkspace(state) {
  return getPermissionMode(state) !== "read-only";
}

function canRunCommands(state) {
  return getPermissionMode(state) !== "read-only";
}

function skipsPermissionPrompts(state) {
  return getPermissionMode(state) === "danger-full-access";
}

function createState(options, workingDir = cwd()) {
  const detected = detectProjectRoot(workingDir);
  const state = {
    options: {
      ...options,
      permissionMode: normalizePermissionMode(options?.permissionMode),
    },
    workingDir,
    rootDir: detected.rootDir,
    isGitRepo: detected.isGitRepo,
    projectFiles: [],
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    gitStatus: "",
    selectedFiles: new Set(),
    selectionMode: "none",
    expandedFiles: new Set(),
    fileContextBudgets: new Map(),
    lastCommandOutput: "",
    summary: "",
    history: [],
  };

  return refreshProjectSnapshot(state);
}

function normalizeRelative(rootDir, inputPath) {
  const absolute = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(rootDir, inputPath);
  return toPosixPath(path.relative(rootDir, absolute));
}

function resolveFileQuery(state, query) {
  const cleaned = query.trim();
  if (!cleaned) {
    return { matches: [], error: "Falta una ruta o filtro." };
  }

  const exactRelative = normalizeRelative(state.rootDir, cleaned);
  const exactAbsolute = path.resolve(state.rootDir, cleaned);

  if (fs.existsSync(exactAbsolute) && fs.statSync(exactAbsolute).isFile()) {
    return { matches: [exactRelative] };
  }

  const normalized = cleaned.toLowerCase();
  const matches = state.projectFiles.filter((filePath) => {
    const lower = filePath.toLowerCase();
    return lower === normalized || lower.includes(normalized);
  });

  if (matches.length === 0) {
    return { matches: [], error: `No encontre archivos para "${cleaned}".` };
  }

  return { matches };
}

function replaceSelectedFiles(state, nextFiles, mode = "manual") {
  const nextSelection = new Set(nextFiles);
  state.selectedFiles = nextSelection;
  state.selectionMode = nextSelection.size > 0 ? mode : "none";

  for (const relativePath of [...state.fileContextBudgets.keys()]) {
    if (!nextSelection.has(relativePath)) {
      state.fileContextBudgets.delete(relativePath);
    }
  }

  for (const relativePath of [...state.expandedFiles]) {
    if (!nextSelection.has(relativePath)) {
      state.expandedFiles.delete(relativePath);
    }
  }
}

function listFiles(state, filter = "") {
  const normalized = filter.trim().toLowerCase();
  const files = normalized
    ? state.projectFiles.filter((filePath) => filePath.toLowerCase().includes(normalized))
    : state.projectFiles;

  return {
    files,
    preview: files.slice(0, MAX_FILES_PREVIEW),
    hiddenCount: Math.max(0, files.length - MAX_FILES_PREVIEW),
  };
}

function addFiles(state, queries, mode = "manual") {
  const added = [];
  const warnings = [];

  for (const query of queries) {
    const result = resolveFileQuery(state, query);
    if (result.error) {
      warnings.push(result.error);
      continue;
    }

    if (result.matches.length > MAX_FILES_PREVIEW) {
      warnings.push(
        `"${query}" coincide con ${result.matches.length} archivos. Usa algo mas especifico.`
      );
      continue;
    }

    for (const match of result.matches) {
      state.selectedFiles.add(match);
      added.push(match);
    }
  }

  if (added.length > 0) {
    state.selectionMode = mode;
  }

  return { added: [...new Set(added)], warnings };
}

function dropFiles(state, queries) {
  const removed = [];
  const warnings = [];

  for (const query of queries) {
    const result = resolveFileQuery(state, query);
    if (result.error) {
      warnings.push(result.error);
      continue;
    }

    for (const match of result.matches) {
      if (state.selectedFiles.delete(match)) {
        removed.push(match);
      }
      state.fileContextBudgets.delete(match);
      state.expandedFiles.delete(match);
    }
  }

  state.selectionMode = state.selectedFiles.size > 0 ? "manual" : "none";
  return { removed: [...new Set(removed)], warnings };
}

async function readFileForContext(rootDir, relativePath, maxBytes = MAX_FILE_BYTES) {
  const absolute = path.join(rootDir, relativePath);
  const raw = await fsp.readFile(absolute, "utf8");
  return truncateText(raw, maxBytes);
}

function getFileContextBudget(state, relativePath) {
  return state.fileContextBudgets.get(relativePath) || MAX_FILE_BYTES;
}

function setFileContextBudget(state, relativePath, budget) {
  state.fileContextBudgets.set(relativePath, budget);
  if (budget > MAX_FILE_BYTES) {
    state.expandedFiles.add(relativePath);
  }
}

function bumpFileContextBudget(state, relativePath) {
  const current = getFileContextBudget(state, relativePath);
  const next = FILE_CONTEXT_LEVELS.find((level) => level > current) || current;
  if (next > current) {
    setFileContextBudget(state, relativePath, next);
    return true;
  }

  return false;
}

function getContextByteBudget(state) {
  if (state.selectedFiles.size === 1) {
    const onlyFile = [...state.selectedFiles][0];
    return Math.min(
      64 * 1024,
      Math.max(MAX_TOTAL_FILE_BYTES, getFileContextBudget(state, onlyFile) + 1024)
    );
  }

  return MAX_TOTAL_FILE_BYTES;
}

function estimateSelectedFilesContextBytes(state) {
  let totalBytes = 0;
  const totalBudget = getContextByteBudget(state);

  for (const relativePath of [...state.selectedFiles].sort()) {
    if (totalBytes >= totalBudget) {
      break;
    }

    try {
      const absolute = path.join(state.rootDir, relativePath);
      const fileSize = fs.statSync(absolute).size;
      totalBytes += Math.min(fileSize, getFileContextBudget(state, relativePath));
    } catch {
      continue;
    }
  }

  return Math.min(totalBytes, totalBudget);
}

function estimateRepoMapBytes(state) {
  const repoMap = state.projectFiles.slice(0, MAX_REPO_MAP_FILES);
  if (!repoMap.length) {
    return 0;
  }

  let preview = repoMap.join("\n");
  if (state.projectFiles.length > repoMap.length) {
    preview += `\n[+${state.projectFiles.length - repoMap.length} archivos mas]`;
  }

  return Buffer.byteLength(preview, "utf8");
}

function estimateStaticContextBytes(state) {
  let total = 0;
  total += Buffer.byteLength(state.options.systemPrompt || "", "utf8");
  total += Buffer.byteLength(state.workingDir || "", "utf8");
  total += Buffer.byteLength(state.rootDir || "", "utf8");
  total += Buffer.byteLength(state.summary || "", "utf8");
  total += Buffer.byteLength(state.gitStatus || "", "utf8");
  total += estimateRepoMapBytes(state);
  total += estimateSelectedFilesContextBytes(state);
  total += Buffer.byteLength(state.lastCommandOutput || "", "utf8");
  total += 768;
  return total;
}

function estimateTokens(bytes) {
  return Math.max(1, Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN));
}

function estimateHistoryBytes(state, nextPrompt = "") {
  const historyBytes = state.history.reduce((total, message) => {
    return total + Buffer.byteLength(message.content || "", "utf8");
  }, 0);

  return historyBytes + Buffer.byteLength(nextPrompt, "utf8");
}

function estimateContextStats(state, draft = "") {
  const contextWindow = state.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
  const historyBytes = estimateHistoryBytes(state, draft);
  const usedBytes = Math.min(HISTORY_COMPACT_TRIGGER_BYTES, historyBytes);
  const remainingBytes = Math.max(0, HISTORY_COMPACT_TRIGGER_BYTES - usedBytes);
  const promptBytes = estimateStaticContextBytes(state) + historyBytes;
  const usedTokens = Math.min(contextWindow, estimateTokens(promptBytes));
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  const percentLeft = Math.max(
    0,
    Math.min(100, Math.round((remainingTokens / contextWindow) * 100))
  );

  return {
    historyBytes,
    usedBytes,
    remainingBytes,
    usedTokens,
    remainingTokens,
    percentLeft,
  };
}

async function buildContextBlock(state) {
  const lines = [];
  lines.push(`CWD: ${state.workingDir}`);
  lines.push(`PROJECT_ROOT: ${state.rootDir}`);

  if (state.summary) {
    lines.push("SESSION_SUMMARY:");
    lines.push(state.summary);
  }

  if (state.gitStatus) {
    lines.push("GIT_STATUS:");
    lines.push(state.gitStatus);
  }

  const repoMapLimit = state.selectedFiles.size > 0 ? 12 : MAX_REPO_MAP_FILES;
  const repoMap = state.projectFiles.slice(0, repoMapLimit);
  if (repoMap.length) {
    lines.push("PROJECT_FILES:");
    lines.push(repoMap.join("\n"));
    if (state.projectFiles.length > repoMap.length) {
      lines.push(`[+${state.projectFiles.length - repoMap.length} archivos mas]`);
    }
  }

  if (state.selectedFiles.size > 0) {
    lines.push("SELECTED_FILES:");
    let totalBytes = 0;
    const totalBudget = getContextByteBudget(state);

    for (const relativePath of [...state.selectedFiles].sort()) {
      if (totalBytes >= totalBudget) {
        lines.push("[mas archivos omitidos por limite de contexto]");
        break;
      }

      try {
        const maxBytes = getFileContextBudget(state, relativePath);
        const { text } = await readFileForContext(state.rootDir, relativePath, maxBytes);
        const nextBytes = Buffer.byteLength(text, "utf8");
        if (totalBytes + nextBytes > totalBudget) {
          lines.push("[mas archivos omitidos por limite de contexto]");
          break;
        }

        totalBytes += nextBytes;
        lines.push(`--- FILE: ${relativePath} ---`);
        lines.push(text);
      } catch (error) {
        lines.push(`--- FILE: ${relativePath} ---`);
        lines.push(
          `[error leyendo archivo: ${error instanceof Error ? error.message : String(error)}]`
        );
      }
    }
  } else {
    lines.push("SELECTED_FILES: ninguno");
  }

  if (state.lastCommandOutput) {
    lines.push("LAST_COMMAND_OUTPUT:");
    lines.push(state.lastCommandOutput);
  }

  return lines.join("\n");
}

function makeConversationMessages(state, userPrompt) {
  const recentHistory = state.history.slice(-MAX_HISTORY_MESSAGES);
  return recentHistory.concat([{ role: "user", content: userPrompt }]);
}

function compactConversation(state, reason = "auto") {
  if (state.history.length === 0) {
    return false;
  }

  const summaryLines = [];
  if (state.summary) {
    summaryLines.push("RESUMEN_PREVIO:");
    summaryLines.push(state.summary);
  }

  summaryLines.push("HISTORIAL_COMPACTADO:");
  for (const message of state.history) {
    const cleaned = String(message.content || "").replace(/\s+/g, " ").trim();
    const shortened = truncateText(cleaned, 420).text.replace(/\s+/g, " ").trim();
    summaryLines.push(`- ${message.role}: ${shortened}`);
  }

  if (state.lastCommandOutput) {
    const commandText = truncateText(
      state.lastCommandOutput.replace(/\s+/g, " ").trim(),
      600
    ).text;
    summaryLines.push(`- ultimo_comando: ${commandText}`);
  }

  state.summary = truncateText(summaryLines.join("\n"), SUMMARY_MAX_BYTES).text.trim();
  state.history = [];
  return { reason };
}

function maybeCompactConversation(state, nextPrompt = "") {
  if (estimateHistoryBytes(state, nextPrompt) < HISTORY_COMPACT_TRIGGER_BYTES) {
    return false;
  }

  return compactConversation(state, "auto");
}

function scoreProjectFiles(projectFiles, tokens) {
  const scores = new Map();

  for (const filePath of projectFiles) {
    const normalizedPath = normalizeSearchText(filePath);
    const baseName = normalizeSearchText(path.posix.basename(filePath));
    let score = 0;

    for (const token of tokens) {
      if (baseName.includes(token)) {
        score += 8;
      }

      if (normalizedPath.includes(token)) {
        score += 5;
      }
    }

    if (score > 0) {
      scores.set(filePath, score);
    }
  }

  return scores;
}

function addContentSearchScores(rootDir, tokens, scores) {
  if (!tokens.length || !commandExists("rg")) {
    return scores;
  }

  for (const token of tokens.slice(0, 5)) {
    const result = runCapture("rg", ["-l", "-i", "--fixed-strings", token, "."], {
      cwd: rootDir,
    });
    if (result.status !== 0 && result.status !== 1) {
      continue;
    }

    for (const line of result.stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const relativePath = line.replace(/^\.\//, "");
      scores.set(relativePath, (scores.get(relativePath) || 0) + 2);
    }
  }

  return scores;
}

function autoDetectRelevantFiles(state, prompt) {
  const tokens = extractSearchTokens(prompt);
  if (!tokens.length || !state.projectFiles.length) {
    return [];
  }

  const scored = addContentSearchScores(
    state.rootDir,
    tokens,
    scoreProjectFiles(state.projectFiles, tokens)
  );

  return [...scored.entries()]
    .filter(([, score]) => score >= 5)
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
    .slice(0, AUTO_CONTEXT_MAX_FILES)
    .map(([filePath]) => filePath);
}

function pickAutoContextFiles(state, prompt) {
  const matches = autoDetectRelevantFiles(state, prompt);
  const originalSelection = state.selectedFiles;
  const originalMode = state.selectionMode;
  const workingSelection = new Set();
  const picked = [];

  for (const match of matches) {
    workingSelection.add(match);
    state.selectedFiles = workingSelection;
    state.selectionMode = "auto";

    if (estimateContextStats(state).remainingTokens < 700) {
      workingSelection.delete(match);
      continue;
    }

    picked.push(match);
  }

  state.selectedFiles = originalSelection;
  state.selectionMode = originalMode;
  return picked;
}

function getImplicitEditSelection(state, prompt) {
  if (state.selectionMode === "manual" && state.selectedFiles.size > 0) {
    return [...state.selectedFiles];
  }

  return pickAutoContextFiles(state, prompt);
}

function isSafeProjectEditPath(relativePath) {
  const normalized = toPosixPath(path.posix.normalize(relativePath || "")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    return false;
  }

  const deniedPrefixes = [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    ".next/",
  ];

  return !deniedPrefixes.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
  );
}

function getContextSummary(state) {
  const lines = [
    `Proyecto: ${state.rootDir}`,
    `Permisos: ${getPermissionMode(state)}`,
    `Archivos en contexto: ${state.selectedFiles.size}`,
  ];

  if (state.selectedFiles.size > 0) {
    for (const filePath of [...state.selectedFiles].sort()) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push(`Resumen acumulado: ${state.summary ? "si" : "no"}`);
  if (state.lastCommandOutput) {
    lines.push("Salida de comando guardada: si");
  }

  return lines.join("\n");
}

function getStatusSummary(state, model = "") {
  const stats = estimateContextStats(state);
  const lines = [
    `Proyecto: ${state.rootDir}`,
    `Repositorio git: ${state.isGitRepo ? "si" : "no"}`,
    `Modelo: ${model || "sin seleccionar"}`,
    `Permisos: ${getPermissionMode(state)}`,
    `Archivos indexados: ${state.projectFiles.length}`,
    `Archivos en contexto: ${state.selectedFiles.size}`,
    `Ventana restante: ~${stats.remainingTokens} tok (${stats.percentLeft}% libre)`,
    `Historial activo: ${state.history.length} mensaje(s)`,
    `Resumen acumulado: ${state.summary ? "si" : "no"}`,
    `Salida de comando guardada: ${state.lastCommandOutput ? "si" : "no"}`,
  ];

  if (state.selectedFiles.size > 0) {
    lines.push("Seleccion actual:");
    for (const filePath of [...state.selectedFiles].sort()) {
      lines.push(`- ${filePath}`);
    }
  }

  if (state.gitStatus) {
    lines.push("Cambios git:");
    lines.push(state.gitStatus);
  }

  return lines.join("\n");
}

async function readFileContent(state, query) {
  const result = resolveFileQuery(state, query);
  if (result.error) {
    return { error: result.error };
  }

  if (result.matches.length > 1) {
    return {
      error: `"${query}" coincide con varios archivos:`,
      matches: result.matches.slice(0, MAX_FILES_PREVIEW),
    };
  }

  const relativePath = result.matches[0];
  const absolute = path.join(state.rootDir, relativePath);
  const raw = await fsp.readFile(absolute, "utf8");
  return {
    relativePath,
    content: raw,
  };
}

function runShellCommand(state, command) {
  if (!canRunCommands(state)) {
    return {
      output: "El modo read-only no permite ejecutar comandos.",
      status: null,
      denied: true,
    };
  }

  const normalizedCommand = String(command || "").trim();
  if (!normalizedCommand) {
    return {
      output: "El comando no puede estar vacio.",
      status: null,
      denied: true,
    };
  }

  const result = spawnSync(normalizedCommand, {
    cwd: state.workingDir,
    shell: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  const merged = [result.stdout || "", result.stderr || ""].filter(Boolean).join("\n").trim();
  const truncated = truncateText(merged || "[sin salida]", MAX_COMMAND_OUTPUT_BYTES);
  state.lastCommandOutput = `Comando: ${normalizedCommand}\n${truncated.text}`;
  refreshProjectSnapshot(state);

  return {
    output: truncated.text,
    status: result.status,
    denied: false,
  };
}

function getGitDiff(state) {
  if (!state.isGitRepo) {
    return {
      ok: false,
      output: "El proyecto actual no es un repositorio git.",
    };
  }

  const result = runCapture("git", ["diff", "--", "."], { cwd: state.rootDir });
  if (result.status !== 0) {
    return {
      ok: false,
      output: result.stderr?.trim() || `git diff fallo con codigo ${result.status}.`,
    };
  }

  const text = (result.stdout || "").trim();
  if (!text) {
    return {
      ok: true,
      output: "No hay diff pendiente.",
    };
  }

  return {
    ok: true,
    output: truncateText(text, MAX_COMMAND_OUTPUT_BYTES).text,
  };
}

function searchProjectContent(state, query, options = {}) {
  const cleaned = String(query || "").trim();
  if (!cleaned) {
    return { error: "Falta el texto a buscar.", matches: [] };
  }

  if (!commandExists("rg")) {
    return { error: "rg no esta disponible en este entorno.", matches: [] };
  }

  const maxResults = options.maxResults || 40;
  const result = runCapture(
    "rg",
    ["-n", "-i", "--fixed-strings", "--no-heading", cleaned, "."],
    { cwd: state.rootDir }
  );

  if (result.status !== 0 && result.status !== 1) {
    return {
      error: result.stderr?.trim() || `Fallo rg con codigo ${result.status}.`,
      matches: [],
    };
  }

  const matches = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\.\//, ""));

  return {
    matches: matches.slice(0, maxResults),
    hiddenCount: Math.max(0, matches.length - maxResults),
  };
}

async function readStdinIfNeeded(prompt, input = process.stdin) {
  if (prompt || input.isTTY) {
    return prompt;
  }

  const chunks = [];
  for await (const chunk of input) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

module.exports = {
  addFiles,
  autoDetectRelevantFiles,
  bumpFileContextBudget,
  buildContextBlock,
  commandExists,
  compactConversation,
  canRunCommands,
  canWriteWorkspace,
  createState,
  detectProjectRoot,
  displayPath,
  dropFiles,
  estimateContextStats,
  estimateTokens,
  formatBytes,
  getContextByteBudget,
  getContextSummary,
  getGitDiff,
  getFileContextBudget,
  getImplicitEditSelection,
  getPermissionMode,
  getStatusSummary,
  isSafeProjectEditPath,
  listFiles,
  looksLikeEditRequest,
  makeConversationMessages,
  maybeCompactConversation,
  normalizePermissionMode,
  normalizeSearchText,
  padInline,
  pickAutoContextFiles,
  pluralize,
  readFileContent,
  readFileForContext,
  readStdinIfNeeded,
  refreshProjectSnapshot,
  replaceSelectedFiles,
  resolveFileQuery,
  runCapture,
  runShellCommand,
  searchProjectContent,
  setFileContextBudget,
  skipsPermissionPrompts,
  toPosixPath,
  truncateInline,
  truncateText,
};
