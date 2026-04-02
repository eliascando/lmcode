const { env } = require("node:process");

const DEFAULT_BASE_URL = env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234";
const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"];
const DEFAULT_PERMISSION_MODE = env.LMCODE_PERMISSION_MODE || "workspace-write";
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
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function printHelp(write) {
  const emit = write || ((text) => process.stdout.write(text));
  emit(`Uso:
  lmcode
  lmcode [prompt]
  lmcode --add <archivo> [--add <archivo>] [prompt]
  lmcode --model <id> [prompt]
  lmcode --models
  lmcode --doctor

Opciones:
  --model, -m                    Usa un modelo cargado especifico
  --system, -s                   Cambia el system prompt
  --base-url                     Cambia la URL base de LM Studio
  --add, -a                      Agrega archivos iniciales al contexto
  --models                       Lista modelos detectados
  --doctor                       Revisa el estado del entorno local
  --permission-mode <modo>       read-only | workspace-write | danger-full-access
  --dangerously-skip-permissions Equivale a danger-full-access
  --help, -h                     Muestra esta ayuda

Modo interactivo:
  /help            Ayuda corta
  /models          Lista modelos
  /model           Selector interactivo de modelo
  /model <id>      Cambia o carga un modelo por id
  /load            Alias de /model
  /load <id>       Carga un modelo por id
  /status          Muestra estado de sesion, contexto y permisos
  /permissions     Muestra el modo de permisos actual
  /permissions <m> Cambia permisos: read-only | workspace-write | danger-full-access
  /doctor          Revisa entorno local, LM Studio y herramientas disponibles
  /files [filtro]  Lista archivos del proyecto
  /add <ruta>      Agrega archivos al contexto
  /drop <ruta>     Quita archivos del contexto
  /context         Muestra el contexto actual
  /read <ruta>     Muestra un archivo
  /run <comando>   Ejecuta un comando y guarda la salida en el contexto
  /diff            Muestra git diff actual
  /patch <inst>    Pide un diff unificado sobre los archivos agregados
  /apply <inst>    Propone cambios y los aplica con confirmacion
  /summary         Muestra el resumen acumulado de la sesion
  /compact         Fuerza la compactacion del historial
  /clear           Limpia la conversacion
  /reset           Limpia conversacion, archivos y salida de comandos
  /exit            Sale
`);
}

function parseArgs(args, environment = env) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    modelQuery: environment.LMSTUDIO_MODEL || environment.OPENAI_MODEL || "",
    addQueries: [],
    listModels: false,
    doctor: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    prompt: "",
  };

  const promptParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--models") {
      options.listModels = true;
      continue;
    }

    if (arg === "--doctor") {
      options.doctor = true;
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      options.modelQuery = args[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--system" || arg === "-s") {
      options.systemPrompt = args[index + 1] || DEFAULT_SYSTEM_PROMPT;
      index += 1;
      continue;
    }

    if (arg === "--base-url") {
      options.baseUrl = args[index + 1] || DEFAULT_BASE_URL;
      index += 1;
      continue;
    }

    if (arg === "--add" || arg === "-a") {
      options.addQueries.push(args[index + 1] || "");
      index += 1;
      continue;
    }

    if (arg === "--permission-mode") {
      options.permissionMode = args[index + 1] || DEFAULT_PERMISSION_MODE;
      index += 1;
      continue;
    }

    if (arg === "--dangerously-skip-permissions") {
      options.permissionMode = "danger-full-access";
      continue;
    }

    promptParts.push(arg);
  }

  options.prompt = promptParts.join(" ").trim();
  return options;
}

module.exports = {
  APPLY_MAX_PASSES,
  AUTO_CONTEXT_MAX_FILES,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SYSTEM_PROMPT,
  ESTIMATED_BYTES_PER_TOKEN,
  FILE_CONTEXT_LEVELS,
  HISTORY_COMPACT_TRIGGER_BYTES,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_EXPANDED_FILE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PREVIEW,
  MAX_GIT_STATUS_LINES,
  MAX_HISTORY_MESSAGES,
  MAX_READ_REQUESTS,
  MAX_REPO_MAP_FILES,
  MAX_TOTAL_FILE_BYTES,
  PERMISSION_MODES,
  SPINNER_FRAMES,
  SUMMARY_MAX_BYTES,
  parseArgs,
  printHelp,
};
