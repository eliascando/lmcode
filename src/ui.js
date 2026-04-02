const readlinePromises = require("node:readline/promises");
const { stdin, stdout, stderr, env } = require("node:process");

const { DEFAULT_CONTEXT_WINDOW_TOKENS, HISTORY_COMPACT_TRIGGER_BYTES, SPINNER_FRAMES } =
  require("./config");
const {
  displayPath,
  estimateContextStats,
  estimateTokens,
  formatBytes,
  getPermissionMode,
  pluralize,
  truncateInline,
} = require("./core");

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

function write(text) {
  stdout.write(text);
}

function writeLine(text = "") {
  stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function errorLine(text = "") {
  stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function paint(text, tone) {
  if (!USE_COLOR || !tone) {
    return text;
  }

  return `${tone}${text}${ANSI.reset}`;
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
  secondaryParts.push(getPermissionMode(state));

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

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
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
  cleaned = cleaned.replace(/^\s*FINAL\s*:\s*/i, "");
  cleaned = cleaned.replace(/^\s*RESPUESTA\s+FINAL\s*:\s*/i, "");
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

function printStartupBanner(state, model) {
  writeLine(paint("LM Code", THEME.title));
  writeLine(paint(`${model} · LM Studio local · ${displayPath(state.rootDir)}`, THEME.muted));
  writeLine(paint("/help · /models · /status · /context · /exit", THEME.dim));
  write("\n");
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

async function readFancyInput(state, model) {
  if (stdin.isTTY) {
    writeLine(renderPromptHeader(state, model));
  }

  try {
    const answer = await askPlainQuestion(paint("› ", THEME.accent));
    return answer.trim();
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      writeLine(paint("^C", THEME.warn));
      return null;
    }

    throw error;
  }
}

module.exports = {
  askPlainQuestion,
  errorLine,
  paint,
  printStartupBanner,
  readFancyInput,
  renderResponseMeta,
  runWithSpinner,
  sanitizeConsoleResponse,
  theme: THEME,
  write,
  writeLine,
};
