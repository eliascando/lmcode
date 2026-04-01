#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readlinePromises = require("node:readline/promises");
const { spawnSync } = require("node:child_process");
const { stdin, stdout, stderr, exit, argv, env, cwd } = require("node:process");

const DEFAULT_BASE_URL = env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234";
const DEFAULT_SYSTEM_PROMPT =
  env.SYSTEM_PROMPT ||
  [
    "Eres un asistente local de programacion.",
    "Trabajas sobre el proyecto actual.",
    "Se preciso, practico y honesto sobre lo que sabes segun el contexto adjunto.",
    "Responde en texto plano para consola.",
    "No uses markdown, tablas, bloques de codigo ni fences.",
    "No le pidas al usuario que use /add si puedes inferir o pedir archivos de forma interna.",
    "Cuando te pidan cambiar codigo, intenta resolverlo de forma autonoma.",
  ].join(" ");

const MAX_REPO_MAP_FILES = 60;
const MAX_GIT_STATUS_LINES = 40;
const MAX_FILE_BYTES = 8 * 1024;
const MAX_EXPANDED_FILE_BYTES = 14 * 1024;
const MAX_TOTAL_FILE_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024;
const MAX_HISTORY_MESSAGES = 6;
const MAX_FILES_PREVIEW = 30;
const HISTORY_COMPACT_TRIGGER_BYTES = 6 * 1024;
const SUMMARY_MAX_BYTES = 3 * 1024;
const AUTO_CONTEXT_MAX_FILES = 4;
const APPLY_MAX_PASSES = 6;
const MAX_READ_REQUESTS = 5;
const FILE_CONTEXT_LEVELS = [MAX_FILE_BYTES, MAX_EXPANDED_FILE_BYTES, 24 * 1024, 48 * 1024];
const DEFAULT_CONTEXT_WINDOW_TOKENS =
  Number.parseInt(
    env.LMCODE_CONTEXT_TOKENS || env.LMSTUDIO_CONTEXT_TOKENS || env.CONTEXT_WINDOW || "4096",
    10
  ) || 4096;
const ESTIMATED_BYTES_PER_TOKEN = 4;
const STREAM_PREVIEW_LINES = 12;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const USE_COLOR = stdout.isTTY && !("NO_COLOR" in env);
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[38;5;45m",
  blue: "\x1b[38;5;39m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;221m",
  red: "\x1b[38;5;203m",
  white: "\x1b[38;5;255m",
  gray: "\x1b[38;5;244m",
  magenta: "\x1b[38;5;213m",
};
const THEME = {
  border: ANSI.cyan,
  borderSoft: ANSI.blue,
  title: `${ANSI.bold}${ANSI.white}`,
  accent: `${ANSI.bold}${ANSI.cyan}`,
  dim: `${ANSI.dim}${ANSI.gray}`,
  muted: ANSI.gray,
  input: ANSI.white,
  placeholder: ANSI.gray,
  good: ANSI.green,
  warn: ANSI.yellow,
  bad: ANSI.red,
  tag: ANSI.magenta,
};

function printHelp() {
  stdout.write(`Uso:
  lmcode
  lmcode [prompt]
  lmcode --add <archivo> [--add <archivo>] [prompt]
  lmcode --model <id> [prompt]
  lmcode --models

Opciones:
  --model, -m      Usa un modelo cargado especifico
  --system, -s     Cambia el system prompt
  --base-url       Cambia la URL base de LM Studio
  --add, -a        Agrega archivos iniciales al contexto
  --models         Lista modelos detectados
  --help, -h       Muestra esta ayuda

Modo interactivo:
  /help            Ayuda corta
  /models          Lista modelos
  /model           Selector interactivo de modelo
  /model <id>      Cambia o carga un modelo por id
  /load            Alias de /model
  /load <id>       Carga un modelo por id
  /files [filtro]  Lista archivos del proyecto
  /add <ruta>      Agrega archivos al contexto
  /drop <ruta>     Quita archivos del contexto
  /context         Muestra el contexto actual
  /read <ruta>     Muestra un archivo
  /run <comando>   Ejecuta un comando y guarda la salida en el contexto
  /patch <inst>    Pide un diff unificado sobre los archivos agregados
  /apply <inst>    Propone cambios y los aplica con confirmacion
  /summary         Muestra el resumen acumulado de la sesion
  /compact         Fuerza la compactacion del historial
  /clear           Limpia la conversacion
  /reset           Limpia conversacion, archivos y salida de comandos
  /exit            Sale
`);
}

function parseArgs(args) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    modelQuery: env.LMSTUDIO_MODEL || env.OPENAI_MODEL || "",
    addQueries: [],
    listModels: false,
    prompt: "",
  };

  const promptParts = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--models") {
      options.listModels = true;
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      options.modelQuery = args[i + 1] || "";
      i += 1;
      continue;
    }

    if (arg === "--system" || arg === "-s") {
      options.systemPrompt = args[i + 1] || DEFAULT_SYSTEM_PROMPT;
      i += 1;
      continue;
    }

    if (arg === "--base-url") {
      options.baseUrl = args[i + 1] || DEFAULT_BASE_URL;
      i += 1;
      continue;
    }

    if (arg === "--add" || arg === "-a") {
      options.addQueries.push(args[i + 1] || "");
      i += 1;
      continue;
    }

    promptParts.push(arg);
  }

  options.prompt = promptParts.join(" ").trim();
  return options;
}

function buildHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };
  const apiKey = env.LMSTUDIO_API_KEY || env.OPENAI_API_KEY || env.API_KEY || "";
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function requestJson(baseUrl, pathName, method = "GET", body) {
  const url = `${baseUrl.replace(/\/$/, "")}${pathName}`;
  const response = await fetchWithRetry(url, {
    method,
    headers: buildHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let data = null;

  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`La respuesta no es JSON valido:\n${rawText}`);
    }
  }

  if (!response.ok) {
    throw new Error(
      `LM Studio devolvio ${response.status} ${response.statusText}\n${JSON.stringify(
        data,
        null,
        2
      )}`
    );
  }

  return data;
}

async function streamChatCompletion(baseUrl, model, messages, hooks = {}) {
  hooks.onStatus?.("conectando a LM Studio");
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LM Studio devolvio ${response.status} ${response.statusText}\n${errorText}`);
  }

  if (!response.body) {
    throw new Error("No se pudo leer el stream de LM Studio.");
  }

  hooks.onStatus?.("esperando primeros tokens");
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const lines = block.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = data?.choices?.[0]?.delta?.content;
        const token = extractTextContent(delta);
        if (token) {
          hooks.onToken?.(token);
          fullText += token;
        }
      }
    }
  }

  hooks.onStatus?.("respuesta completa");
  hooks.onComplete?.(fullText);
  return fullText.trim();
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return item.text || "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = 1) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        throw error;
      }
      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError;
}

async function chatCompletion(baseUrl, model, messages) {
  const data = await requestJson(baseUrl, "/v1/chat/completions", "POST", {
    model,
    messages,
    temperature: 0.2,
    stream: false,
  });

  const content = data?.choices?.[0]?.message?.content;
  const text = extractTextContent(content);
  return text || JSON.stringify(data, null, 2);
}

async function fetchModels(baseUrl) {
  const data = await requestJson(baseUrl, "/api/v1/models");
  const models = Array.isArray(data?.models)
    ? data.models
    : Array.isArray(data?.data)
    ? data.data
    : null;

  if (!models) {
    throw new Error("No pude leer la lista de modelos de LM Studio.");
  }

  return models.filter((model) => model?.type === "llm");
}

function loadedModels(models) {
  return models.filter(
    (model) => Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0
  );
}

function printModels(models) {
  if (!models.length) {
    stdout.write("No se encontraron modelos LLM.\n");
    return;
  }

  for (const model of models) {
    const state = modelStateLabel(model);
    stdout.write(`${model.key}  [${state}]  ${model.display_name || ""}\n`);
  }
}

function modelLoadedCount(model) {
  return Array.isArray(model.loaded_instances) ? model.loaded_instances.length : 0;
}

function modelStateLabel(model) {
  return modelLoadedCount(model) > 0 ? "loaded" : model.state || "unloaded";
}

function modelContextLength(model) {
  const firstInstance = Array.isArray(model.loaded_instances) ? model.loaded_instances[0] : null;
  return (
    firstInstance?.context_length ||
    firstInstance?.n_ctx ||
    firstInstance?.max_context_length ||
    firstInstance?.load_config?.context_length ||
    firstInstance?.config?.context_length ||
    model?.context_length ||
    model?.max_context_length ||
    model?.n_ctx ||
    null
  );
}

function modelInstanceId(model) {
  const firstInstance = Array.isArray(model.loaded_instances) ? model.loaded_instances[0] : null;
  return (
    firstInstance?.instance_id ||
    firstInstance?.id ||
    firstInstance?.identifier ||
    firstInstance?.key ||
    model?.instance_id ||
    null
  );
}

function matchModel(models, query) {
  if (!query) {
    return null;
  }

  const normalized = query.toLowerCase();

  return (
    models.find((model) => model.key === query) ||
    models.find((model) => model.display_name === query) ||
    models.find((model) => model.key?.toLowerCase() === normalized) ||
    models.find((model) => model.display_name?.toLowerCase() === normalized) ||
    models.find((model) => model.key?.toLowerCase().includes(normalized)) ||
    models.find((model) => model.display_name?.toLowerCase().includes(normalized)) ||
    null
  );
}

async function chooseModel(baseUrl, requestedModel, interactive, forcePrompt = false) {
  const models = await fetchModels(baseUrl);
  const loaded = loadedModels(models);

  async function ensureLoaded(model) {
    if (modelLoadedCount(model) > 0) {
      return {
        key: model.key,
        contextLength: modelContextLength(model) || DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
    }

    stdout.write(`Cargando modelo ${model.key}...\n`);
    const result = await requestJson(baseUrl, "/api/v1/models/load", "POST", {
      model: model.key,
      context_length: DEFAULT_CONTEXT_WINDOW_TOKENS,
      echo_load_config: true,
    });
    const contextLength =
      result?.load_config?.context_length || DEFAULT_CONTEXT_WINDOW_TOKENS;
    stdout.write(
      `Modelo cargado: ${model.key} · ${contextLength} tok · ${result?.load_time_seconds || "?"}s\n`
    );
    return {
      key: model.key,
      contextLength,
    };
  }

  async function promptModelSelection(pool, currentModel = "") {
    const sorted = [...pool].sort((left, right) => {
      const leftLoaded = modelLoadedCount(left) > 0 ? 0 : 1;
      const rightLoaded = modelLoadedCount(right) > 0 ? 0 : 1;
      return leftLoaded - rightLoaded || left.key.localeCompare(right.key);
    });

    if (!sorted.length) {
      throw new Error("No hay modelos disponibles en LM Studio.");
    }

    stdout.write("Modelos disponibles:\n");
    sorted.forEach((model, index) => {
      const marker = model.key === currentModel ? "*" : " ";
      stdout.write(
        `${marker}${index + 1}. ${model.key} [${modelStateLabel(model)}] ${model.display_name || ""}\n`
      );
    });

    const selectedIndex = Math.max(0, sorted.findIndex((model) => model.key === currentModel));
    const answer = (await askPlainQuestion(`Modelo [${selectedIndex + 1}]: `)).trim();
    const pickedIndex = Number.parseInt(answer || String(selectedIndex + 1), 10) - 1;
    return sorted[pickedIndex] || sorted[selectedIndex];
  }

  if (requestedModel) {
    const matched = matchModel(loaded, requestedModel) || matchModel(models, requestedModel);
    if (!matched) {
      throw new Error(`No encontre un modelo que coincida con "${requestedModel}".`);
    }
    return ensureLoaded(matched);
  }

  if (loaded.length === 0) {
    if (!interactive) {
      throw new Error("No hay modelos cargados en LM Studio. Usa /model o /load para cargar uno.");
    }

    const selected = await promptModelSelection(models);
    return ensureLoaded(selected);
  }

  if (!interactive || (loaded.length === 1 && !forcePrompt)) {
    return {
      key: loaded[0].key,
      contextLength: modelContextLength(loaded[0]) || DEFAULT_CONTEXT_WINDOW_TOKENS,
    };
  }

  const selected = await promptModelSelection(models, loaded[0]?.key || "");
  return ensureLoaded(selected);
}

async function unloadModel(baseUrl, instanceId) {
  if (!instanceId) {
    return false;
  }

  await requestJson(baseUrl, "/api/v1/models/unload", "POST", {
    instance_id: instanceId,
  });
  return true;
}

async function switchModel(baseUrl, currentModelKey, requestedModel, interactive, forcePrompt = false) {
  const selected = await chooseModel(baseUrl, requestedModel, interactive, forcePrompt);

  if (!currentModelKey || currentModelKey === selected.key) {
    return selected;
  }

  try {
    const models = await fetchModels(baseUrl);
    const previous = matchModel(models, currentModelKey);
    const previousInstanceId = modelInstanceId(previous);

    if (previous && previousInstanceId) {
      stdout.write(`Descargando modelo anterior ${currentModelKey}...\n`);
      await unloadModel(baseUrl, previousInstanceId);
      stdout.write(`Modelo descargado: ${currentModelKey}\n`);
    }
  } catch (error) {
    stderr.write(
      `No pude descargar el modelo anterior ${currentModelKey}: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }

  return selected;
}

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

function displayPath(inputPath) {
  const homeDir = env.HOME || os.homedir();
  const absolute = path.resolve(inputPath);

  if (absolute === homeDir) {
    return "~";
  }

  if (absolute.startsWith(`${homeDir}${path.sep}`)) {
    return `~/${toPosixPath(path.relative(homeDir, absolute))}`;
  }

  return absolute;
}

function paint(text, tone) {
  if (!USE_COLOR || !tone) {
    return text;
  }

  return `${tone}${text}${ANSI.reset}`;
}

function renderBox(lines, options = {}) {
  const minWidth = options.minWidth || 45;
  const terminalWidth = stdout.isTTY && Number.isInteger(stdout.columns) ? stdout.columns : 0;
  const maxWidth = terminalWidth > 8 ? Math.max(minWidth, terminalWidth - 4) : 72;
  const rawWidth = Math.max(minWidth, ...lines.map((line) => line.length));
  const contentWidth = Math.min(rawWidth, maxWidth);
  const content = lines.map((line) => `│ ${padInline(truncateInline(line, contentWidth), contentWidth)} │`);

  return [
    `╭${"─".repeat(contentWidth + 2)}╮`,
    ...content,
    `╰${"─".repeat(contentWidth + 2)}╯`,
  ].join("\n");
}

function colorizeFrameLine(line, contentTone = THEME.input) {
  if (!USE_COLOR) {
    return line;
  }

  if (
    (line.startsWith("╭") && line.endsWith("╮")) ||
    (line.startsWith("╰") && line.endsWith("╯")) ||
    (line.startsWith("├") && line.endsWith("┤"))
  ) {
    return paint(line, THEME.border);
  }

  if (line.startsWith("│ ") && line.endsWith(" │")) {
    const content = line.slice(2, -2);
    return `${paint("│", THEME.border)} ${paint(content, contentTone)} ${paint("│", THEME.border)}`;
  }

  return paint(line, contentTone);
}

function renderStatusLine(model, rootDir) {
  const line = `  ${model} · LM Studio local · ${displayPath(rootDir)}`;
  if (!stdout.isTTY || !Number.isInteger(stdout.columns) || stdout.columns < 10) {
    return paint(line, THEME.muted);
  }

  return paint(truncateInline(line, stdout.columns - 1), THEME.muted);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getPromptWidth(lines, minWidth = 48) {
  const terminalWidth = stdout.isTTY && Number.isInteger(stdout.columns) ? stdout.columns : 0;
  const maxWidth = terminalWidth > 8 ? Math.max(minWidth, terminalWidth - 4) : 72;
  const rawWidth = Math.max(minWidth, ...lines.map((line) => line.length));
  return Math.min(rawWidth, maxWidth);
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

function renderMeter(percent, width = 16) {
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function toneForPercent(percent) {
  if (percent >= 60) {
    return THEME.good;
  }

  if (percent >= 30) {
    return THEME.warn;
  }

  return THEME.bad;
}

function terminalContentWidth(fallback = 80) {
  if (stdout.isTTY && Number.isInteger(stdout.columns) && stdout.columns > 4) {
    return stdout.columns - 1;
  }

  return fallback;
}

function clearCurrentLine() {
  stdout.write("\r\x1b[2K");
}

function renderPromptHeader(state, model) {
  const stats = estimateContextStats(state);
  const width = terminalContentWidth();
  const primary = truncateInline(
    `${model} · ${stats.percentLeft}% libre · ${displayPath(state.rootDir)}`,
    width
  );
  const secondaryParts = [`~${stats.remainingTokens} tok libres`];

  if (state.selectedFiles.size > 0) {
    secondaryParts.push(`${pluralize(state.selectedFiles.size, "archivo")} en contexto`);
  }

  if (stats.historyBytes > 0) {
    secondaryParts.push(`hist ${formatBytes(stats.historyBytes)}`);
  }

  if (state.summary) {
    secondaryParts.push("resumen");
  }

  if (state.lastCommandOutput) {
    secondaryParts.push("cmd");
  }

  const secondary = truncateInline(secondaryParts.join(" · "), width);
  return [
    paint(primary, toneForPercent(stats.percentLeft)),
    paint(secondary, THEME.dim),
  ].join("\n");
}

function renderSpinnerLine(model, status, startedAt) {
  const width = terminalContentWidth();
  const seconds = formatSeconds(Date.now() - startedAt);
  const line = `${model} · ${status} · ${seconds}`;
  return paint(truncateInline(line, width), THEME.dim);
}

function renderResponseMeta(model, text, startedAt) {
  const width = terminalContentWidth();
  const elapsed = formatSeconds(Date.now() - startedAt);
  const tokens = text ? estimateTokens(Buffer.byteLength(text, "utf8")) : 0;
  const line = `${model} · ${tokens} tok resp · ${elapsed}`;
  return paint(truncateInline(line, width), THEME.dim);
}

function sanitizeConsoleResponse(text) {
  let cleaned = String(text || "");
  cleaned = cleaned.replace(/```[a-zA-Z0-9_-]*\n?/g, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");
  cleaned = cleaned.replace(/__(.*?)__/g, "$1");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

  const lines = cleaned.split("\n");
  const normalizedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\|?[\s:-]+\|[\s|:-]*$/.test(trimmed)) {
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      normalizedLines.push(cells.join(" | "));
      continue;
    }

    normalizedLines.push(line);
  }

  cleaned = normalizedLines.join("\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

async function runWithSpinner(model, label, task) {
  if (!stdout.isTTY) {
    return task();
  }

  const startedAt = Date.now();
  let spinnerIndex = 0;
  clearCurrentLine();
  stdout.write(renderSpinnerLine(model, `${SPINNER_FRAMES[spinnerIndex]} ${label}`, startedAt));

  const spinnerTimer = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    clearCurrentLine();
    stdout.write(renderSpinnerLine(model, `${SPINNER_FRAMES[spinnerIndex]} ${label}`, startedAt));
  }, 90);

  try {
    return await task();
  } finally {
    clearInterval(spinnerTimer);
    clearCurrentLine();
  }
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

  return [...new Set(
    normalizeSearchText(prompt)
      .split(/[^a-z0-9_./-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  )];
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
    const result = runCapture("rg", ["-l", "-i", "--fixed-strings", token, "."], { cwd: rootDir });
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

function ensureRelevantFilesInContext(state, prompt) {
  if (state.selectedFiles.size > 0) {
    return [...state.selectedFiles];
  }

  const matches = autoDetectRelevantFiles(state, prompt);
  const originalSelection = state.selectedFiles;
  const workingSelection = new Set();
  const picked = [];

  for (const match of matches) {
    workingSelection.add(match);
    state.selectedFiles = workingSelection;

    if (estimateContextStats(state).remainingTokens < 700) {
      workingSelection.delete(match);
      continue;
    }

    picked.push(match);
  }

  state.selectedFiles = originalSelection;
  return picked;
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

  return !deniedPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function getResponsePanelWidth() {
  const terminalWidth = stdout.isTTY && Number.isInteger(stdout.columns) ? stdout.columns : 0;
  if (terminalWidth > 8) {
    return Math.max(60, Math.min(terminalWidth - 4, 92));
  }

  return 76;
}

function wrapTextToWidth(text, width) {
  const safeWidth = Math.max(1, width);
  const rawLines = String(text || "").replace(/\r/g, "").split("\n");
  const wrapped = [];

  for (const rawLine of rawLines) {
    const normalized = rawLine.replace(/\t/g, "  ");
    if (!normalized.length) {
      wrapped.push("");
      continue;
    }

    let remaining = normalized;
    while (remaining.length > safeWidth) {
      const slice = remaining.slice(0, safeWidth);
      const splitAt = slice.lastIndexOf(" ");
      if (splitAt > Math.floor(safeWidth * 0.55)) {
        wrapped.push(slice.slice(0, splitAt));
        remaining = remaining.slice(splitAt + 1);
      } else {
        wrapped.push(slice);
        remaining = remaining.slice(safeWidth);
      }
    }

    wrapped.push(remaining);
  }

  return wrapped;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function buildResponseFrame(model, prompt, text, options = {}) {
  const width = getResponsePanelWidth();
  const elapsed = formatSeconds(options.elapsedMs || 0);
  const responseBytes = Buffer.byteLength(text || "", "utf8");
  const responseTokens = text ? estimateTokens(responseBytes) : 0;
  const statusLabel = options.error
    ? "error"
    : options.done
    ? "completo"
    : `${options.spinner || "•"} ${options.status || "generando"}`;
  const line1 = `assistant  ${model}`;
  const line2 = `status     ${statusLabel} · ${elapsed} · ${responseTokens} tok resp`;
  const line3 = `prompt     ${truncateInline(prompt, Math.max(10, width - 11))}`;
  let bodyLines = wrapTextToWidth(text, width);

  if (!bodyLines.length || (bodyLines.length === 1 && !bodyLines[0])) {
    bodyLines = [options.error || "Esperando respuesta del modelo..."];
  }

  if (options.previewOnly && bodyLines.length > STREAM_PREVIEW_LINES) {
    bodyLines = [
      `[… ${bodyLines.length - STREAM_PREVIEW_LINES} lineas ocultas …]`,
      ...bodyLines.slice(-STREAM_PREVIEW_LINES),
    ];
  }

  const plainLines = [
    `╭${"─".repeat(width + 2)}╮`,
    `│ ${padInline(truncateInline(line1, width), width)} │`,
    `│ ${padInline(truncateInline(line2, width), width)} │`,
    `│ ${padInline(truncateInline(line3, width), width)} │`,
    `├${"─".repeat(width + 2)}┤`,
    ...bodyLines.map((line) => `│ ${padInline(truncateInline(line, width), width)} │`),
    `╰${"─".repeat(width + 2)}╯`,
  ];
  const statusTone = options.error
    ? THEME.bad
    : options.done
    ? THEME.good
    : THEME.accent;
  const tones = [
    THEME.border,
    THEME.title,
    statusTone,
    THEME.muted,
    THEME.borderSoft,
    ...bodyLines.map(() => (options.error ? THEME.bad : THEME.input)),
    THEME.border,
  ];

  return plainLines.map((line, index) => colorizeFrameLine(line, tones[index]));
}

function layoutInputLines(buffer, cursorIndex, width) {
  const firstPrefix = "› ";
  const nextPrefix = "  ";
  const firstWidth = Math.max(1, width - firstPrefix.length);
  const nextWidth = Math.max(1, width - nextPrefix.length);
  const lines = [];

  if (!buffer.length) {
    return {
      lines: [{ prefix: firstPrefix, text: "", placeholder: "Escribe aqui..." }],
      cursorRow: 0,
      cursorCol: 2 + firstPrefix.length,
    };
  }

  let remaining = buffer;
  let prefix = firstPrefix;
  let segmentWidth = firstWidth;

  while (remaining.length > segmentWidth) {
    lines.push({ prefix, text: remaining.slice(0, segmentWidth) });
    remaining = remaining.slice(segmentWidth);
    prefix = nextPrefix;
    segmentWidth = nextWidth;
  }

  lines.push({ prefix, text: remaining });

  let row = 0;
  let rest = cursorIndex;
  let cursorPrefix = firstPrefix;
  let cursorWidth = firstWidth;

  while (row < lines.length - 1 && rest > cursorWidth) {
    rest -= cursorWidth;
    row += 1;
    cursorPrefix = nextPrefix;
    cursorWidth = nextWidth;
  }

  return {
    lines,
    cursorRow: row,
    cursorCol: 2 + cursorPrefix.length + rest,
  };
}

function buildInputFrame(state, model, draft = "", cursorIndex = draft.length) {
  const stats = estimateContextStats(state, draft);
  const meter = renderMeter(stats.percentLeft);
  const line1 = `model  ${model}`;
  const line2 = `ctx    ${meter} ${stats.percentLeft}% libre · ~${stats.remainingTokens} tok`;
  const line3 = `state  ${displayPath(state.rootDir)} · hist ${formatBytes(
    stats.historyBytes
  )}/${formatBytes(HISTORY_COMPACT_TRIGGER_BYTES)} · ${pluralize(
    state.selectedFiles.size,
    "archivo"
  )}`;
  const line4 = `cache  resumen ${state.summary ? "si" : "no"} · cmd ${
    state.lastCommandOutput ? "si" : "no"
  } · ventana ${DEFAULT_CONTEXT_WINDOW_TOKENS} tok`;
  const width = getPromptWidth([line1, line2, line3, line4], 60);
  const inputLayout = layoutInputLines(draft, cursorIndex, width);
  const plainLines = [
    `╭${"─".repeat(width + 2)}╮`,
    `│ ${padInline(truncateInline(line1, width), width)} │`,
    `│ ${padInline(truncateInline(line2, width), width)} │`,
    `│ ${padInline(truncateInline(line3, width), width)} │`,
    `│ ${padInline(truncateInline(line4, width), width)} │`,
    `├${"─".repeat(width + 2)}┤`,
    ...inputLayout.lines.map((line) => {
      const content = line.text
        ? `${line.prefix}${line.text}`
        : `${line.prefix}${line.placeholder || ""}`;
      return `│ ${padInline(truncateInline(content, width), width)} │`;
    }),
    `╰${"─".repeat(width + 2)}╯`,
  ];
  const tones = [
    THEME.border,
    THEME.accent,
    toneForPercent(stats.percentLeft),
    THEME.input,
    THEME.muted,
    THEME.borderSoft,
    ...inputLayout.lines.map((line) => (line.text ? THEME.input : THEME.placeholder)),
    THEME.border,
  ];
  const rendered = plainLines.map((line, index) => colorizeFrameLine(line, tones[index]));
  const hint = paint(
    "  Enter envia · Ctrl+C sale · /help · /models · /context · /exit",
    THEME.dim
  );

  return {
    lines: [...rendered, hint],
    cursorRow: 6 + inputLayout.cursorRow,
    cursorCol: inputLayout.cursorCol,
  };
}

function printStartupBanner(state, model) {
  stdout.write(`${paint("LM Code", THEME.title)}\n`);
  stdout.write(`${paint(`${model} · LM Studio local · ${displayPath(state.rootDir)}`, THEME.muted)}\n`);
  stdout.write(`${paint("/help · /models · /context · /exit", THEME.dim)}\n\n`);
}

async function askPlainQuestion(promptText) {
  const rl = readlinePromises.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  try {
    return await rl.question(promptText);
  } finally {
    rl.close();
  }
}

function clearRenderedFrame(renderState) {
  if (!renderState?.lineCount) {
    return;
  }

  stdout.write("\r");
  if (renderState.cursorRow > 0) {
    stdout.write(`\x1b[${renderState.cursorRow}A`);
  }

  for (let index = 0; index < renderState.lineCount; index += 1) {
    stdout.write("\x1b[2K");
    if (index < renderState.lineCount - 1) {
      stdout.write("\x1b[1B\r");
    }
  }

  if (renderState.lineCount > 1) {
    stdout.write(`\x1b[${renderState.lineCount - 1}A`);
  }
  stdout.write("\r");
}

function positionRenderedFrameCursor(renderState) {
  stdout.write("\r");
  const upLines = renderState.lineCount - 1 - renderState.cursorRow;
  if (upLines > 0) {
    stdout.write(`\x1b[${upLines}A`);
  }
  if (renderState.cursorCol > 0) {
    stdout.write(`\x1b[${renderState.cursorCol}C`);
  }
}

function moveCursorBelowFrame(renderState) {
  stdout.write("\r");
  const downLines = renderState.lineCount - 1 - renderState.cursorRow;
  if (downLines > 0) {
    stdout.write(`\x1b[${downLines}B`);
  }
  stdout.write("\n");
}

function sanitizeTypedChunk(chunk) {
  return String(chunk || "").replace(/\r/g, "").replace(/\n/g, " ");
}

async function readFancyInput(state, model) {
  if (stdin.isTTY) {
    stdout.write(`${renderPromptHeader(state, model)}\n`);
  }

  try {
    const answer = await askPlainQuestion(paint("› ", THEME.accent));
    return answer.trim();
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      stdout.write(`${paint("^C", THEME.warn)}\n`);
      return null;
    }
    throw error;
  }
}

async function askModelInteractive(state, model, prompt) {
  const startedAt = Date.now();
  try {
    await maybeCompactConversation(state, model, prompt);
    const context = await buildContextBlock(state);
    const messages = [
      { role: "system", content: state.options.systemPrompt },
      {
        role: "system",
        content: `Contexto del proyecto actual:\n${context}`,
      },
      ...makeConversationMessages(state, prompt),
    ];
    const rawAnswer = await runWithSpinner(model, "pensando", () =>
      chatCompletion(state.options.baseUrl, model, messages)
    );
    const finalText = sanitizeConsoleResponse(rawAnswer);
    if (finalText) {
      stdout.write(finalText.endsWith("\n") ? finalText : `${finalText}\n`);
    }
    stdout.write(`${renderResponseMeta(model, finalText, startedAt)}\n\n`);
    return rawAnswer.trim();
  } catch (error) {
    stderr.write(`${paint(error instanceof Error ? error.message : String(error), THEME.bad)}\n`);
    throw error;
  }
}

function makeState(options) {
  const workingDir = cwd();
  const detected = detectProjectRoot(workingDir);
  const rootDir = detected.rootDir;
  const homeDir = env.HOME || "";
  const shouldIndexProject = detected.isGitRepo || rootDir !== homeDir;
  const projectFiles = shouldIndexProject ? listProjectFiles(rootDir) : [];

  return {
    options,
    workingDir,
    rootDir,
    isGitRepo: detected.isGitRepo,
    projectFiles,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    gitStatus: detected.isGitRepo ? getGitStatus(rootDir) : "",
    selectedFiles: new Set(),
    expandedFiles: new Set(),
    fileContextBudgets: new Map(),
    lastCommandOutput: "",
    summary: "",
    history: [],
  };
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

function replaceSelectedFiles(state, nextFiles) {
  const nextSelection = new Set(nextFiles);
  state.selectedFiles = nextSelection;

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

  if (!files.length) {
    stdout.write("No se encontraron archivos.\n");
    return;
  }

  const preview = files.slice(0, MAX_FILES_PREVIEW);
  preview.forEach((filePath) => stdout.write(`${filePath}\n`));

  if (files.length > preview.length) {
    stdout.write(`[+${files.length - preview.length} archivos mas]\n`);
  }
}

async function addFiles(state, queries) {
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
    }
  }

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
    return Math.min(64 * 1024, Math.max(MAX_TOTAL_FILE_BYTES, getFileContextBudget(state, onlyFile) + 1024));
  }

  return MAX_TOTAL_FILE_BYTES;
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
        lines.push(`[error leyendo archivo: ${error instanceof Error ? error.message : String(error)}]`);
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

function estimateHistoryBytes(state, nextPrompt = "") {
  const historyBytes = state.history.reduce((total, message) => {
    return total + Buffer.byteLength(message.content || "", "utf8");
  }, 0);

  return historyBytes + Buffer.byteLength(nextPrompt, "utf8");
}

function renderHistoryForSummary(state) {
  const parts = [];

  if (state.summary) {
    parts.push("RESUMEN_PREVIO:");
    parts.push(state.summary);
  }

  parts.push("HISTORIAL_RECIENTE:");
  for (const message of state.history) {
    parts.push(`${message.role.toUpperCase()}:`);
    parts.push(message.content);
  }

  if (state.lastCommandOutput) {
    parts.push("ULTIMA_SALIDA_DE_COMANDO:");
    parts.push(state.lastCommandOutput);
  }

  return parts.join("\n");
}

function compactConversation(state, _model, reason = "auto") {
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
    const cmd = truncateText(state.lastCommandOutput.replace(/\s+/g, " ").trim(), 600).text;
    summaryLines.push(`- ultimo_comando: ${cmd}`);
  }

  state.summary = truncateText(summaryLines.join("\n"), SUMMARY_MAX_BYTES).text.trim();
  state.history = [];
  stdout.write(`[contexto resumido: ${reason}]\n`);
  return true;
}

async function maybeCompactConversation(state, model, nextPrompt = "") {
  if (estimateHistoryBytes(state, nextPrompt) < HISTORY_COMPACT_TRIGGER_BYTES) {
    return false;
  }

  try {
    return compactConversation(state, model, "auto");
  } catch (error) {
    stderr.write(
      `No pude compactar el contexto: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return false;
  }
}

async function askModel(state, model, prompt, stream = true, options = {}) {
  if (!options.skipCompact) {
    await maybeCompactConversation(state, model, prompt);
  }

  const context = await buildContextBlock(state);
  const messages = [
    { role: "system", content: state.options.systemPrompt },
    {
      role: "system",
      content: `Contexto del proyecto actual:\n${context}`,
    },
    ...makeConversationMessages(state, prompt),
  ];

  if (stream) {
    return streamChatCompletion(state.options.baseUrl, model, messages);
  }

  return chatCompletion(state.options.baseUrl, model, messages);
}

async function readStdinIfNeeded(prompt) {
  if (prompt || stdin.isTTY) {
    return prompt;
  }

  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

async function printContext(state) {
  stdout.write(`Proyecto: ${state.rootDir}\n`);
  stdout.write(`Archivos en contexto: ${state.selectedFiles.size}\n`);
  if (state.selectedFiles.size > 0) {
    [...state.selectedFiles].sort().forEach((filePath) => stdout.write(`- ${filePath}\n`));
  }
  stdout.write(`Resumen acumulado: ${state.summary ? "si" : "no"}\n`);
  if (state.lastCommandOutput) {
    stdout.write("Salida de comando guardada: si\n");
  }
}

async function readFileCommand(state, query) {
  const result = resolveFileQuery(state, query);
  if (result.error) {
    stderr.write(`${result.error}\n`);
    return;
  }

  if (result.matches.length > 1) {
    stderr.write(`"${query}" coincide con varios archivos:\n`);
    result.matches.slice(0, MAX_FILES_PREVIEW).forEach((filePath) => stderr.write(`${filePath}\n`));
    return;
  }

  const relativePath = result.matches[0];
  const absolute = path.join(state.rootDir, relativePath);
  const raw = await fsp.readFile(absolute, "utf8");
  stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
}

function runShellCommand(state, command) {
  const result = spawnSync(command, {
    cwd: state.workingDir,
    shell: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  const merged = [result.stdout || "", result.stderr || ""].filter(Boolean).join("\n").trim();
  const truncated = truncateText(merged || "[sin salida]", MAX_COMMAND_OUTPUT_BYTES);
  state.lastCommandOutput = `Comando: ${command}\n${truncated.text}`;

  if (merged) {
    stdout.write(merged.endsWith("\n") ? merged : `${merged}\n`);
  } else {
    stdout.write("[sin salida]\n");
  }
}

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
    "Maximo 5 rutas.",
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
      `Si solo necesitas modificar un archivo, devuelve ese archivo completo: ${[...state.selectedFiles][0]}`
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
  const regex = /<<<FILE:(.+?)>>>\r?\n([\s\S]*?)\r?\n<<<END FILE>>>/g;
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
  const regex = /<<<READ:(.+?)>>>/g;
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

    const result = runCapture("diff", ["-u", "--label", `a/${relativePath}`, "--label", `b/${relativePath}`, beforePath, afterPath]);
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

async function previewPatch(state, model, instruction) {
  if (state.selectedFiles.size === 0) {
    stderr.write("Agrega archivos con /add antes de pedir un patch.\n");
    return;
  }

  const patch = await askModel(state, model, buildPatchPrompt(state, instruction), false);
  stdout.write(patch.endsWith("\n") ? patch : `${patch}\n`);
}

async function applyChanges(state, model, instruction, options = {}) {
  if (state.selectedFiles.size === 0) {
    const autoFiles = ensureRelevantFilesInContext(state, instruction);
    if (!autoFiles.length) {
      stderr.write("No pude detectar archivos relevantes para aplicar cambios.\n");
      return false;
    }
    replaceSelectedFiles(state, autoFiles);
    stdout.write(`${paint("Contexto detectado:", THEME.dim)} ${autoFiles.join(", ")}\n`);
  }

  let response = "";
  let blocks = [];
  let pass = 0;
  let forceFileOutput = false;
  let lastReadRequests = [];

  while (pass < APPLY_MAX_PASSES) {
    response = await runWithSpinner(model, "preparando cambios", () =>
      askModel(state, model, buildApplyPrompt(state, instruction, { forceFileOutput }), false)
    );
    blocks = extractApplyBlocks(state, response);

    if (blocks.length) {
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
    warnings.forEach((warning) => stderr.write(`${warning}\n`));
    if (added.length > 0) {
      stdout.write(`${paint("Leyendo contexto adicional:", THEME.dim)} ${added.join(", ")}\n`);
      pass += 1;
      continue;
    }

    if (!forceFileOutput) {
      stdout.write(
        `${paint("Contexto ya ampliado al maximo; forzando propuesta con lo disponible.", THEME.dim)}\n`
      );
      forceFileOutput = true;
      pass += 1;
      continue;
    }

    break;
  }

  if (!blocks.length) {
    if (lastReadRequests.length > 0) {
      stderr.write(
        "El modelo siguio pidiendo mas lectura del mismo contexto y no devolvio archivos editables.\n"
      );
    } else {
      stderr.write("No pude extraer cambios aplicables de la respuesta del modelo.\n");
    }
    if (!options.silentOnFailure) {
      const cleaned = sanitizeConsoleResponse(response);
      stdout.write(cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`);
    }
    return false;
  }

  const diffs = [];
  const pendingWrites = [];

  for (const block of blocks) {
    const relativePath = toPosixPath(block.relativePath);
    if (!isSafeProjectEditPath(relativePath)) {
      stderr.write(`Ignorando ruta insegura: ${relativePath}\n`);
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
    stdout.write("No hay cambios para aplicar.\n");
    return false;
  }

  stdout.write(diffs.join("\n"));
  if (!options.autoConfirm) {
    const answer = (await askPlainQuestion("Aplicar cambios? [y/N]: ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes" && answer !== "si" && answer !== "s") {
      stdout.write("Cambios cancelados.\n");
      return false;
    }
  }

  for (const item of pendingWrites) {
    await fsp.mkdir(path.dirname(item.absolute), { recursive: true });
    await fsp.writeFile(item.absolute, item.content, "utf8");
  }

  stdout.write(`Cambios aplicados en ${pendingWrites.length} archivo(s).\n`);
  return true;
}

async function runOneShot(state, model, prompt) {
  const rawAnswer = await askModel(state, model, prompt, false);
  const answer = sanitizeConsoleResponse(rawAnswer);
  stdout.write(answer.endsWith("\n") ? answer : `${answer}\n`);
  if (rawAnswer) {
    state.history.push({ role: "user", content: prompt });
    state.history.push({ role: "assistant", content: rawAnswer });
  }
}

async function runInteractive(state, model) {
  printStartupBanner(state, model);

  while (true) {
    const input = await readFancyInput(state, model);

    if (input === null) {
      return;
    }

    if (!input) {
      continue;
    }

    if (input === "/exit" || input === "/quit") {
      return;
    }

    if (input === "/help") {
      stdout.write(
        "/models  /model  /model <id>  /load  /load <id>  /files [filtro]  /add <ruta>  /drop <ruta>  /context  /read <ruta>  /run <cmd>  /patch <inst>  /apply <inst>  /summary  /compact  /clear  /reset  /exit\n"
      );
      continue;
    }

    if (input === "/models") {
      printModels(await fetchModels(state.options.baseUrl));
      continue;
    }

    if (input.startsWith("/model ")) {
      const nextModel = input.slice(7).trim();
      const selected = await switchModel(state.options.baseUrl, model, nextModel, false);
      model = selected.key;
      state.contextWindowTokens = selected.contextLength || state.contextWindowTokens;
      state.history = [];
      state.summary = "";
      state.expandedFiles.clear();
      state.fileContextBudgets.clear();
      stdout.write(`Modelo cambiado a ${model}\n`);
      continue;
    }

    if (input === "/model" || input === "/load") {
      const selected = await switchModel(state.options.baseUrl, model, "", true, true);
      model = selected.key;
      state.contextWindowTokens = selected.contextLength || state.contextWindowTokens;
      state.history = [];
      state.summary = "";
      state.expandedFiles.clear();
      state.fileContextBudgets.clear();
      stdout.write(`Modelo activo: ${model}\n`);
      continue;
    }

    if (input.startsWith("/load ")) {
      const selected = await switchModel(state.options.baseUrl, model, input.slice(6).trim(), false);
      model = selected.key;
      state.contextWindowTokens = selected.contextLength || state.contextWindowTokens;
      state.history = [];
      state.summary = "";
      state.expandedFiles.clear();
      state.fileContextBudgets.clear();
      stdout.write(`Modelo activo: ${model}\n`);
      continue;
    }

    if (input === "/clear") {
      state.history = [];
      state.summary = "";
      state.expandedFiles.clear();
      stdout.write("Conversacion limpiada.\n");
      continue;
    }

    if (input === "/reset") {
      state.history = [];
      state.summary = "";
      state.selectedFiles.clear();
      state.expandedFiles.clear();
      state.fileContextBudgets.clear();
      state.lastCommandOutput = "";
      stdout.write("Contexto reiniciado.\n");
      continue;
    }

    if (input === "/summary") {
      if (!state.summary) {
        stdout.write("No hay resumen acumulado todavia.\n");
      } else {
        stdout.write(state.summary.endsWith("\n") ? state.summary : `${state.summary}\n`);
      }
      continue;
    }

    if (input === "/compact") {
      const compacted = await compactConversation(state, model, "manual");
      if (!compacted) {
        stdout.write("No habia historial para resumir.\n");
      }
      continue;
    }

    if (input.startsWith("/files")) {
      listFiles(state, input.slice(6));
      continue;
    }

    if (input.startsWith("/add ")) {
      const { added, warnings } = await addFiles(state, [input.slice(5).trim()]);
      warnings.forEach((warning) => stderr.write(`${warning}\n`));
      if (added.length) {
        stdout.write(`Agregados:\n${added.join("\n")}\n`);
      }
      continue;
    }

    if (input.startsWith("/drop ")) {
      const { removed, warnings } = dropFiles(state, [input.slice(6).trim()]);
      warnings.forEach((warning) => stderr.write(`${warning}\n`));
      removed.forEach((relativePath) => {
        state.fileContextBudgets.delete(relativePath);
        state.expandedFiles.delete(relativePath);
      });
      if (removed.length) {
        stdout.write(`Quitados:\n${removed.join("\n")}\n`);
      }
      continue;
    }

    if (input === "/context") {
      await printContext(state);
      continue;
    }

    if (input.startsWith("/read ")) {
      await readFileCommand(state, input.slice(6).trim());
      continue;
    }

    if (input.startsWith("/run ")) {
      runShellCommand(state, input.slice(5).trim());
      continue;
    }

    if (input.startsWith("/patch ")) {
      await previewPatch(state, model, input.slice(7).trim());
      continue;
    }

    if (input.startsWith("/apply ")) {
      await applyChanges(state, model, input.slice(7).trim());
      continue;
    }

    try {
      if (looksLikeEditRequest(input)) {
        const autoFiles = ensureRelevantFilesInContext(state, input);
        if (autoFiles.length > 0) {
          replaceSelectedFiles(state, autoFiles);
          stdout.write(
            `${paint("Contexto detectado:", THEME.dim)} ${autoFiles.join(", ")}\n`
          );
        }

        const applied = await applyChanges(state, model, input, {
          autoConfirm: true,
          silentOnFailure: true,
        });
        if (applied) {
          state.history.push({ role: "user", content: input });
          state.history.push({ role: "assistant", content: "Cambios aplicados automaticamente." });
        }
        continue;
      }

      const answer = await askModelInteractive(state, model, input);
      state.history.push({ role: "user", content: input });
      state.history.push({ role: "assistant", content: answer });
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
  }
}

async function main() {
  const options = parseArgs(argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const state = makeState(options);

  if (options.listModels) {
    printModels(await fetchModels(options.baseUrl));
    return;
  }

  if (options.addQueries.length > 0) {
    const { warnings } = await addFiles(state, options.addQueries);
    warnings.forEach((warning) => stderr.write(`${warning}\n`));
  }

  const selectedModel = await chooseModel(
    options.baseUrl,
    options.modelQuery,
    !options.prompt && stdin.isTTY
  );
  const model = selectedModel.key;
  state.contextWindowTokens = selectedModel.contextLength || state.contextWindowTokens;
  const prompt = await readStdinIfNeeded(options.prompt);

  if (prompt) {
    await runOneShot(state, model, prompt);
    return;
  }

  await runInteractive(state, model);
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
