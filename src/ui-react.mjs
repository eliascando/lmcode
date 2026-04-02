import {stdout} from "node:process";

import React, {useEffect, useMemo, useState} from "react";
import {render, Box, Spacer, Text, useApp, useInput, useStdout} from "ink";

import config from "./config.js";
import core from "./core.js";
import legacyUi from "./ui.js";

const h = React.createElement;
const MAX_PANEL_ITEMS = 6;
const MAX_PICKER_VISIBLE_ITEMS = 10;
const SLASH_COMMANDS = [
  {command: "/help", description: "Ayuda corta"},
  {command: "/models", description: "Lista modelos"},
  {command: "/model", description: "Selector interactivo de modelo"},
  {command: "/load", description: "Alias de /model"},
  {command: "/status", description: "Estado de la sesion"},
  {command: "/permissions", description: "Ver o cambiar permisos"},
  {command: "/doctor", description: "Diagnostico del entorno"},
  {command: "/files", description: "Listar archivos"},
  {command: "/add", description: "Agregar archivo al contexto"},
  {command: "/drop", description: "Quitar archivo del contexto"},
  {command: "/context", description: "Resumen del contexto"},
  {command: "/read", description: "Leer archivo"},
  {command: "/run", description: "Ejecutar comando"},
  {command: "/diff", description: "Ver diff git"},
  {command: "/patch", description: "Pedir diff unificado"},
  {command: "/apply", description: "Aplicar cambios"},
  {command: "/summary", description: "Ver resumen"},
  {command: "/compact", description: "Compactar historial"},
  {command: "/clear", description: "Limpiar conversacion"},
  {command: "/reset", description: "Reiniciar contexto"},
  {command: "/exit", description: "Salir"},
];

const THEME = {
  title: "cyan",
  border: "cyan",
  accent: "magenta",
  info: "blue",
  good: "green",
  warn: "yellow",
  bad: "red",
  dim: "gray",
  muted: "gray",
  input: "white",
  user: "cyan",
  system: "magenta",
};

const LOG_STYLES = {
  input: {label: "usuario", color: THEME.user},
  output: {label: "lmcode", color: THEME.input},
  system: {label: "sistema", color: THEME.system},
  error: {label: "error", color: THEME.bad},
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ellipsize(text, maxLength = 48) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function firstLine(text = "") {
  return String(text || "").split(/\r?\n/)[0] || "";
}

function normalizeSearchValue(text = "") {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function countGitChanges(gitStatus = "") {
  return String(gitStatus || "")
    .split(/\r?\n/)
    .filter(Boolean).length;
}

function renderBar(current, total, width = 18) {
  if (total <= 0) {
    return "░".repeat(width);
  }

  const filled = clamp(Math.round((current / total) * width), 0, width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export function getResponsiveLayout(terminalWidth = 120, terminalHeight = 40) {
  const width = Math.max(80, Number(terminalWidth) || 120);
  const height = Math.max(24, Number(terminalHeight) || 40);
  const dense = height < 34;
  const maxLogs = clamp(dense ? height - 18 : height - 14, dense ? 6 : 8, dense ? 12 : 22);

  if (width < 150) {
    return {
      compact: true,
      dense,
      maxLogs,
      mainWidth: width,
      sideWidth: width,
    };
  }

  const sideWidth = clamp(Math.floor(width * 0.26), 36, 42);
  const mainWidth = width - sideWidth - 2;
  if (mainWidth < 72) {
    return {
      compact: true,
      dense,
      maxLogs,
      mainWidth: width,
      sideWidth: width,
    };
  }

  return {
    compact: false,
    dense,
    maxLogs,
    mainWidth,
    sideWidth,
  };
}

export function getSlashSuggestions(input = "") {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  return SLASH_COMMANDS.filter((entry) => entry.command.startsWith(normalized)).slice(0, 6);
}

export function completeSlashCommand(input = "") {
  const normalized = String(input || "");
  const trimmed = normalized.trimStart();
  if (!trimmed.startsWith("/")) {
    return normalized;
  }

  const suggestions = getSlashSuggestions(trimmed);
  if (suggestions.length === 0) {
    return normalized;
  }

  const prefixWhitespace = normalized.slice(0, normalized.length - trimmed.length);
  return `${prefixWhitespace}${suggestions[0].command}${suggestions[0].command.includes(" ") ? "" : " "}`;
}

export function buildCommandPaletteItems(state) {
  const nextPermissionCommand =
    core.getPermissionMode(state) === "read-only"
      ? "/permissions workspace-write"
      : "/permissions read-only";
  const nextPermissionLabel =
    core.getPermissionMode(state) === "read-only" ? "Activar escritura" : "Pasar a solo lectura";

  return [
    {label: "Estado de sesion", description: "Resumen rapido del agente", command: "/status", keywords: "estado status"},
    {label: "Cambiar modelo", description: "Abrir selector de modelos", command: "/model", keywords: "modelo load model"},
    {label: "Listar modelos", description: "Ver modelos detectados", command: "/models", keywords: "modelos lista"},
    {
      label: "Archivos y contexto",
      description: "Abrir selector visual de contexto",
      openPalette: "context",
      keywords: "archivos contexto selector visual add drop readme src",
    },
    {label: "Ver contexto", description: "Resumen de archivos fijados", command: "/context", keywords: "contexto archivos"},
    {label: "Doctor", description: "Diagnostico del entorno", command: "/doctor", keywords: "doctor diagnostico lm studio"},
    {label: "Diff git", description: "Ver cambios pendientes", command: "/diff", keywords: "git diff cambios"},
    {
      label: nextPermissionLabel,
      description: `Cambiar permisos a ${nextPermissionCommand.split(" ").slice(1).join(" ")}`,
      command: nextPermissionCommand,
      keywords: "permisos seguridad read only workspace write",
    },
    {label: "Ver resumen", description: "Mostrar resumen acumulado", command: "/summary", keywords: "summary resumen"},
    {label: "Compactar historial", description: "Forzar compactacion", command: "/compact", keywords: "compactar historial"},
    {label: "Limpiar conversacion", description: "Borra historial actual", command: "/clear", keywords: "limpiar clear"},
    {label: "Reiniciar contexto", description: "Limpia historial, contexto y comandos", command: "/reset", keywords: "reset reiniciar contexto"},
    {label: "Ayuda", description: "Mostrar comandos disponibles", command: "/help", keywords: "ayuda help slash"},
    {label: "Salir", description: "Cerrar LM Code", command: "/exit", keywords: "salir exit quit"},
  ];
}

export function buildContextPaletteItems(state) {
  const selected = state.selectedFiles instanceof Set ? state.selectedFiles : new Set();
  const projectFiles = Array.isArray(state.projectFiles) ? state.projectFiles : [];

  return [...projectFiles]
    .sort((left, right) => {
      const leftSelected = selected.has(left) ? 0 : 1;
      const rightSelected = selected.has(right) ? 0 : 1;
      if (leftSelected !== rightSelected) {
        return leftSelected - rightSelected;
      }

      const leftPriority =
        left === "README.md"
          ? 0
          : left === "package.json"
          ? 1
          : left.startsWith("src/")
          ? 2
          : left.startsWith("test/")
          ? 3
          : 10;
      const rightPriority =
        right === "README.md"
          ? 0
          : right === "package.json"
          ? 1
          : right.startsWith("src/")
          ? 2
          : right.startsWith("test/")
          ? 3
          : 10;

      return leftPriority - rightPriority || left.localeCompare(right);
    })
    .map((filePath) => {
      const isSelected = selected.has(filePath);
      return {
        label: filePath,
        description: isSelected ? "En contexto · Enter quita" : "Fuera de contexto · Enter agrega",
        command: `${isSelected ? "/drop" : "/add"} ${filePath}`,
        keywords: `${filePath} ${isSelected ? "drop quitar contexto" : "add agregar contexto"}`,
      };
    });
}

export function filterPaletteItems(items = [], query = "") {
  const normalized = normalizeSearchValue(query);
  if (!normalized) {
    return [...items];
  }

  return items.filter((item) =>
    normalizeSearchValue([item.label, item.description, item.keywords].filter(Boolean).join(" ")).includes(normalized)
  );
}

export function getPickerWindow(items = [], selectedIndex = 0, limit = MAX_PICKER_VISIBLE_ITEMS) {
  if (items.length === 0) {
    return {
      items: [],
      start: 0,
      selectedIndex: 0,
    };
  }

  const safeLimit = Math.max(1, limit);
  const safeSelectedIndex = clamp(selectedIndex, 0, items.length - 1);
  const start = clamp(
    safeSelectedIndex - Math.floor(safeLimit / 2),
    0,
    Math.max(0, items.length - safeLimit)
  );

  return {
    items: items.slice(start, start + safeLimit),
    start,
    selectedIndex: safeSelectedIndex,
  };
}

function buildQuickActions(state) {
  return [
    {label: "Estado", command: "/status", description: "Resumen de sesion"},
    {label: "Modelos", command: "/models", description: "Listar modelos"},
    {label: "Cambiar modelo", command: "/model", description: "Selector visual"},
    {label: "Contexto", command: "/context", description: "Resumen del contexto"},
    {label: "Archivos src", command: "/files src", description: "Explorar src"},
    {label: "Doctor", command: "/doctor", description: "Diagnostico local"},
    {
      label: "Permisos",
      command:
        core.getPermissionMode(state) === "read-only"
          ? "/permissions workspace-write"
          : "/permissions read-only",
      description:
        core.getPermissionMode(state) === "read-only" ? "Volver a escritura" : "Pasar a solo lectura",
    },
    {label: "Diff", command: "/diff", description: "Ver cambios git"},
  ].slice(0, MAX_PANEL_ITEMS);
}

function buildContextActions(state) {
  const source =
    state.selectedFiles.size > 0
      ? [...state.selectedFiles].sort()
      : state.projectFiles.filter((filePath) =>
          ["README.md", "package.json", "src/", "test/"].some((hint) => filePath.startsWith(hint) || filePath === hint)
        );

  return source.slice(0, MAX_PANEL_ITEMS).map((filePath) => ({
    label: ellipsize(filePath, 28),
    command: `/read ${filePath}`,
    description: filePath,
  }));
}

function moveFocus(areas, current, step = 1) {
  const index = areas.indexOf(current);
  const safeIndex = index >= 0 ? index : 0;
  const offset = ((safeIndex + step) % areas.length + areas.length) % areas.length;
  return areas[offset] || "input";
}

function useTerminalDimensions() {
  const inkStdout = useStdout()?.stdout;
  const stream = inkStdout || stdout;
  const [dimensions, setDimensions] = useState(() => ({
    columns: Math.max(80, Number(stream?.columns) || 120),
    rows: Math.max(24, Number(stream?.rows) || 40),
  }));

  useEffect(() => {
    const target = inkStdout || stdout;
    if (!target?.on) {
      return undefined;
    }

    const update = () => {
      setDimensions({
        columns: Math.max(80, Number(target.columns) || 120),
        rows: Math.max(24, Number(target.rows) || 40),
      });
    };

    update();
    target.on("resize", update);
    return () => {
      if (typeof target.off === "function") {
        target.off("resize", update);
      } else if (typeof target.removeListener === "function") {
        target.removeListener("resize", update);
      }
    };
  }, [inkStdout]);

  return dimensions;
}

function createController(initialModel) {
  const listeners = new Set();
  let logId = 0;
  let promptId = 0;
  let pendingResolver = null;
  let pickerResolver = null;
  let snapshot = {
    logs: [],
    pending: false,
    promptKind: "input",
    promptText: "",
    promptId: 0,
    busy: null,
    model: initialModel,
    exitRequested: false,
    picker: null,
  };

  function emit() {
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function appendLog(kind, text = "") {
    snapshot = {
      ...snapshot,
      logs: [
        ...snapshot.logs,
        {
          id: ++logId,
          kind,
          text: String(text ?? ""),
        },
      ],
    };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    appendLog(kind, text = "") {
      appendLog(kind, text);
      emit();
    },
    clearLogs() {
      snapshot = {
        ...snapshot,
        logs: [],
      };
      emit();
    },
    requestLine(kind, promptText = "") {
      if (pendingResolver) {
        throw new Error("Ya hay una entrada pendiente en la interfaz.");
      }

      snapshot = {
        ...snapshot,
        pending: true,
        promptKind: kind,
        promptText: String(promptText || ""),
        promptId: ++promptId,
      };
      emit();

      return new Promise((resolve) => {
        pendingResolver = resolve;
      });
    },
    submitLine(value) {
      if (!pendingResolver) {
        return;
      }

      const resolve = pendingResolver;
      const promptKind = snapshot.promptKind;
      const promptText = snapshot.promptText;
      pendingResolver = null;

      snapshot = {
        ...snapshot,
        pending: false,
        promptText: "",
      };

      if (String(value || "").trim()) {
        if (promptKind === "input") {
          appendLog("input", `› ${value}`);
        } else {
          appendLog("system", `${promptText} ${value}`.trim());
        }
      }

      emit();
      resolve(value);
    },
    cancelLine() {
      if (!pendingResolver) {
        return false;
      }

      const resolve = pendingResolver;
      pendingResolver = null;
      snapshot = {
        ...snapshot,
        pending: false,
        promptText: "",
      };
      emit();
      resolve(null);
      return true;
    },
    setBusy(busy) {
      snapshot = {
        ...snapshot,
        busy,
      };
      emit();
    },
    setModel(model) {
      snapshot = {
        ...snapshot,
        model,
      };
      emit();
    },
    openPicker(config) {
      if (pickerResolver) {
        throw new Error("Ya hay un selector visual abierto.");
      }

      const options = Array.isArray(config?.options) ? config.options : [];
      snapshot = {
        ...snapshot,
        picker: {
          title: config?.title || "Seleccionar opcion",
          hint: config?.hint || "",
          options,
          selectedIndex: clamp(config?.selectedIndex ?? 0, 0, Math.max(0, options.length - 1)),
        },
      };
      emit();

      return new Promise((resolve) => {
        pickerResolver = resolve;
      });
    },
    movePicker(offset) {
      if (!snapshot.picker) {
        return;
      }

      const total = snapshot.picker.options.length;
      if (total === 0) {
        return;
      }

      snapshot = {
        ...snapshot,
        picker: {
          ...snapshot.picker,
          selectedIndex:
            (snapshot.picker.selectedIndex + offset + total) % total,
        },
      };
      emit();
    },
    submitPicker() {
      if (!snapshot.picker || !pickerResolver) {
        return;
      }

      const resolve = pickerResolver;
      const picked = snapshot.picker.options[snapshot.picker.selectedIndex] ?? null;
      pickerResolver = null;
      snapshot = {
        ...snapshot,
        picker: null,
      };
      emit();
      resolve(picked);
    },
    cancelPicker() {
      if (!pickerResolver) {
        snapshot = {
          ...snapshot,
          picker: null,
        };
        emit();
        return false;
      }

      const resolve = pickerResolver;
      pickerResolver = null;
      snapshot = {
        ...snapshot,
        picker: null,
      };
      emit();
      resolve(null);
      return true;
    },
    requestExit() {
      snapshot = {
        ...snapshot,
        exitRequested: true,
      };
      emit();
    },
  };
}

function useControllerSnapshot(controller) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot());

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  return snapshot;
}

function secondsSince(timestamp) {
  if (!timestamp) {
    return "0.0s";
  }

  const ms = Date.now() - timestamp;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
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

function card(title, children, props = {}) {
  const variant = props.variant || "plain";
  const boxProps =
    variant === "card"
      ? {
          borderStyle: "round",
          borderColor: props.borderColor || THEME.border,
          paddingX: 1,
          paddingY: 0,
        }
      : {
          paddingX: 0,
          paddingY: 0,
        };

  return h(
    Box,
    {
      flexDirection: "column",
      marginBottom: props.marginBottom ?? 1,
      width: props.width,
      flexGrow: props.flexGrow,
      ...boxProps,
    },
    title
      ? h(
          Text,
          {
            color: props.titleColor || (variant === "card" ? THEME.title : THEME.muted),
            bold: props.titleBold ?? variant === "card",
          },
          title
        )
      : null,
    children
  );
}

function renderLogItem(item) {
  const style = LOG_STYLES[item.kind] || LOG_STYLES.output;
  return h(
    Box,
    {key: item.id, flexDirection: "column", marginBottom: 0},
    h(
      Box,
      null,
      h(Text, {color: style.color, bold: true}, `${style.label}`),
      h(Text, {color: THEME.dim}, " · "),
      h(Text, {color: style.color, wrap: "wrap"}, item.text.length > 0 ? item.text : " ")
    )
  );
}

function renderSelectableItem(item, isFocused, isSelected, key) {
  const active = isFocused && isSelected;
  return h(
    Box,
    {
      key,
      flexDirection: "column",
      paddingX: 0,
      marginBottom: 0,
    },
    h(
      Text,
      {
        color: active ? THEME.accent : THEME.info,
        inverse: active,
        wrap: "truncate-end",
      },
      `${active ? "›" : " "} ${item.label}`
    ),
    item.description
      ? h(Text, {color: THEME.dim, wrap: "truncate-end"}, `  ${item.description}`)
      : null
  );
}

function HeaderPanel({state, model}) {
  const stats = core.estimateContextStats(state);
  const selected = [...state.selectedFiles].sort();
  const selectedPreview = selected.slice(0, 3);
  const hiddenSelected = Math.max(0, selected.length - selectedPreview.length);
  const contextWindow = state.contextWindowTokens || config.DEFAULT_CONTEXT_WINDOW_TOKENS;
  const usedTokens = Math.max(0, contextWindow - stats.remainingTokens);

  return card(
    null,
    h(
      Box,
      {flexDirection: "column"},
      h(
        Box,
        null,
        h(Text, {color: THEME.title, bold: true}, "LM Code"),
        h(Text, {color: THEME.dim}, " · "),
        h(Text, {color: THEME.info}, model || "sin modelo"),
        h(Spacer, null),
        h(Text, {color: THEME.accent}, core.getPermissionMode(state))
      ),
      h(Text, {color: THEME.muted, wrap: "truncate-middle"}, core.displayPath(state.rootDir)),
      h(
        Box,
        {marginTop: 0},
        h(Text, {color: toneForPercent(stats.percentLeft)}, renderBar(usedTokens, contextWindow)),
        h(Text, {color: THEME.dim}, " "),
        h(Text, {color: toneForPercent(stats.percentLeft)}, `${stats.percentLeft}% libre`)
      ),
      h(
        Box,
        {marginTop: 0},
        h(Text, {color: THEME.dim}, `~${stats.remainingTokens} tok`),
        h(Text, {color: THEME.dim}, " · "),
        h(Text, {color: THEME.dim}, `${state.projectFiles.length} archivos indexados`),
        state.selectedFiles.size > 0
          ? h(
              React.Fragment,
              null,
              h(Text, {color: THEME.dim}, " · "),
              h(Text, {color: THEME.dim}, `${state.selectedFiles.size} en contexto`)
            )
          : null
      ),
      selectedPreview.length > 0
        ? h(
            Text,
            {color: THEME.muted, wrap: "truncate-end"},
            `Contexto: ${selectedPreview.join(", ")}${hiddenSelected > 0 ? ` [+${hiddenSelected}]` : ""}`
          )
        : null
    ),
    {marginBottom: 1, variant: "plain"}
  );
}

function BusyPanel({busy, frameIndex}) {
  if (!busy) {
    return null;
  }

  return card(
    null,
    h(
      Text,
      {color: THEME.accent},
      `${config.SPINNER_FRAMES[frameIndex]} Agente · ${busy.model} · ${busy.label} · ${secondsSince(busy.startedAt)}`
    ),
    {variant: "plain", marginBottom: 1}
  );
}

function ActivityPanel({logs, maxLogs}) {
  const visibleLogs = logs.slice(-maxLogs);

  return card(
    `Actividad · ${visibleLogs.length}`,
    visibleLogs.length > 0
      ? h(
          Box,
          {flexDirection: "column"},
          ...visibleLogs.map((item) => renderLogItem(item))
        )
      : h(Text, {color: THEME.dim}, "Aun no hay actividad."),
    {variant: "plain", titleColor: THEME.title, titleBold: true}
  );
}

function SessionPanel({state, snapshot}) {
  const gitChanges = countGitChanges(state.gitStatus);
  const lastCommand = firstLine(state.lastCommandOutput).replace(/^Comando:\s*/, "");

  return card(
    null,
    h(
      Box,
      {flexDirection: "column"},
      h(
        Text,
        {color: snapshot.busy ? THEME.warn : THEME.good},
        `${snapshot.busy ? "Trabajando" : "Listo"} · Historial ${state.history.length} · Git ${gitChanges}`
      ),
      state.summary ? h(Text, {color: THEME.dim}, "Resumen activo") : null,
      lastCommand
        ? h(Text, {color: THEME.muted, wrap: "truncate-end"}, `Ultimo comando: ${ellipsize(lastCommand, 36)}`)
        : h(Text, {color: THEME.dim}, "Ultimo comando: ninguno")
    ),
    {variant: "plain"}
  );
}

function FilesPanel({state}) {
  const selected = [...state.selectedFiles].sort().slice(0, 6);
  const hidden = Math.max(0, state.selectedFiles.size - selected.length);

  return card(
    "Contexto",
    selected.length > 0
      ? h(
          Box,
          {flexDirection: "column"},
          ...selected.map((filePath, index) =>
            h(Text, {key: `${filePath}-${index}`, color: THEME.muted, wrap: "truncate-end"}, `• ${filePath}`)
          ),
          hidden > 0 ? h(Text, {color: THEME.dim}, `[+${hidden} archivos mas]`) : null
        )
      : h(Text, {color: THEME.dim}, "No hay archivos fijados en contexto.")
  );
}

function ActionPanel({title, items, focusedArea, area, selectedIndex, emptyText}) {
  return card(
    title,
    items.length > 0
      ? h(
          Box,
          {flexDirection: "column"},
          ...items.map((item, index) =>
            renderSelectableItem(item, focusedArea === area, selectedIndex === index, `${area}-${index}`)
          )
        )
      : h(Text, {color: THEME.dim}, emptyText),
    {variant: "plain"}
  );
}

function SuggestionsPanel({inputBuffer, snapshot}) {
  const suggestions =
    snapshot.promptKind === "input" ? getSlashSuggestions(inputBuffer) : [];

  if (snapshot.promptKind === "question") {
    return card(
      "Respuestas utiles",
      h(
        Box,
        {flexDirection: "column"},
        h(Text, {color: THEME.muted}, "Respuestas utiles: y / yes / si / s"),
        h(Text, {color: THEME.dim}, "Enter envia la respuesta actual.")
      ),
      {variant: "plain"}
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  return card(
    "Sugerencias",
    h(
      Box,
      {flexDirection: "column"},
      ...suggestions.map((entry, index) =>
        h(
          Box,
          {key: `${entry.command}-${index}`},
          h(Text, {color: index === 0 ? THEME.accent : THEME.info}, entry.command),
          h(Text, {color: THEME.dim}, " · "),
          h(Text, {color: THEME.muted, wrap: "truncate-end"}, entry.description)
        )
      ),
      h(Text, {color: THEME.dim}, "Tab completa el primer comando.")
    ),
    {variant: "plain"}
  );
}

function FooterPanel({snapshot, inputBuffer, historySize}) {
  const helper =
    snapshot.promptKind === "question"
      ? snapshot.promptText || "Respuesta requerida"
      : "Escribe un prompt o un comando slash";
  const promptLabel = snapshot.promptKind === "question" ? "?" : "›";

  return card(
    null,
    h(
      Box,
      {flexDirection: "column"},
      h(
        Box,
        null,
        h(Text, {color: THEME.accent, bold: true}, promptLabel),
        h(Text, {color: THEME.dim}, " "),
        h(Text, {color: THEME.input, wrap: "wrap"}, inputBuffer || " ")
      ),
      h(
        Text,
        {color: THEME.dim},
        snapshot.promptKind === "question"
          ? `${helper} · Enter envia`
          : `Enter envia · Ctrl+P comandos · Ctrl+O archivos · Historial: ${historySize}`
      )
    ),
    {variant: "plain", marginBottom: 0}
  );
}

function CompactSupportPanels({
  state,
  snapshot,
  inputBuffer,
  historySize,
  quickActions,
  contextActions,
  focusedArea,
  actionSelection,
  layout,
}) {
  return h(
    Box,
    {flexDirection: "column"},
    h(SessionPanel, {state, snapshot}),
    h(
      ActionPanel,
      {
        title: "Acciones",
        items: quickActions,
        focusedArea,
        area: "quick",
        selectedIndex: actionSelection.quick,
        emptyText: "No hay acciones sugeridas.",
      }
    ),
    h(
      ActionPanel,
      {
        title: "Archivos",
        items: contextActions,
        focusedArea,
        area: "context",
        selectedIndex: actionSelection.context,
        emptyText: "No hay archivos sugeridos.",
      }
    ),
    !layout.dense || snapshot.promptKind === "question" || getSlashSuggestions(inputBuffer).length > 0
      ? h(SuggestionsPanel, {inputBuffer, snapshot})
      : null
  );
}

function PickerPanel({picker}) {
  if (!picker) {
    return null;
  }

  return card(
    picker.title,
    h(
      Box,
      {flexDirection: "column"},
      picker.hint ? h(Text, {color: THEME.dim}, picker.hint) : null,
      ...picker.options.map((option, index) =>
        renderSelectableItem(
          {
            label: option.label,
            description: option.description,
          },
          true,
          picker.selectedIndex === index,
          `picker-${index}`
        )
      ),
      h(Text, {color: THEME.dim}, "↑/↓ mover · Enter elegir · Esc cancelar")
    ),
    {borderColor: THEME.accent, titleColor: THEME.accent, variant: "card"}
  );
}

function SearchablePalettePanel({title, hint, query, items, selectedIndex, dense}) {
  const windowed = getPickerWindow(items, selectedIndex, dense ? 8 : MAX_PICKER_VISIBLE_ITEMS);

  return card(
    title,
    h(
      Box,
      {flexDirection: "column"},
      hint ? h(Text, {color: THEME.dim}, hint) : null,
      h(
        Box,
        {marginTop: hint ? 0 : 0},
        h(Text, {color: THEME.info}, "Filtro"),
        h(Text, {color: THEME.dim}, ": "),
        h(Text, {color: THEME.input}, query || "sin filtro")
      ),
      h(Text, {color: THEME.dim}, `${items.length} resultado(s)`),
      items.length > 0
        ? h(
            Box,
            {flexDirection: "column"},
            windowed.start > 0 ? h(Text, {color: THEME.dim}, `… ${windowed.start} arriba`) : null,
            ...windowed.items.map((item, index) =>
              renderSelectableItem(
                item,
                true,
                windowed.selectedIndex === windowed.start + index,
                `palette-${windowed.start + index}`
              )
            ),
            windowed.start + windowed.items.length < items.length
              ? h(Text, {color: THEME.dim}, `… ${items.length - (windowed.start + windowed.items.length)} abajo`)
              : null
          )
        : h(Text, {color: THEME.dim}, "No hay coincidencias para ese filtro."),
      h(Text, {color: THEME.dim}, "Escribe para filtrar · ↑/↓ mover · Enter ejecutar · Esc cerrar")
    ),
    {borderColor: THEME.accent, titleColor: THEME.accent, variant: "card"}
  );
}

function ReactCliApp({controller, state}) {
  const snapshot = useControllerSnapshot(controller);
  const {exit} = useApp();
  const dimensions = useTerminalDimensions();
  const [inputBuffer, setInputBuffer] = useState("");
  const [frameIndex, setFrameIndex] = useState(0);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState("");
  const [focusedArea, setFocusedArea] = useState("input");
  const [overlay, setOverlay] = useState(null);
  const [actionSelection, setActionSelection] = useState({
    quick: 0,
    context: 0,
  });

  useEffect(() => {
    setInputBuffer("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    setFocusedArea("input");
  }, [snapshot.promptId]);

  useEffect(() => {
    if (!snapshot.busy) {
      setFrameIndex(0);
      return undefined;
    }

    const timer = setInterval(() => {
      setFrameIndex((current) => (current + 1) % config.SPINNER_FRAMES.length);
    }, 90);

    return () => clearInterval(timer);
  }, [snapshot.busy]);

  useEffect(() => {
    if (snapshot.exitRequested) {
      exit();
    }
  }, [snapshot.exitRequested, exit]);

  const quickActions = useMemo(() => buildQuickActions(state), [state]);
  const contextActions = useMemo(() => buildContextActions(state), [state]);
  const commandPaletteItems = useMemo(() => buildCommandPaletteItems(state), [state]);
  const contextPaletteItems = useMemo(() => buildContextPaletteItems(state), [state]);
  const focusAreas = useMemo(() => {
    const areas = ["input"];
    if (quickActions.length > 0) {
      areas.push("quick");
    }
    if (contextActions.length > 0) {
      areas.push("context");
    }
    return areas;
  }, [quickActions, contextActions]);

  useEffect(() => {
    if (!focusAreas.includes(focusedArea)) {
      setFocusedArea("input");
    }
  }, [focusAreas, focusedArea]);

  const overlayItems = useMemo(() => {
    if (!overlay) {
      return [];
    }

    return overlay.kind === "commands" ? commandPaletteItems : contextPaletteItems;
  }, [overlay, commandPaletteItems, contextPaletteItems]);

  const filteredOverlayItems = useMemo(
    () => filterPaletteItems(overlayItems, overlay?.query || ""),
    [overlayItems, overlay]
  );

  const overlaySelectedIndex = overlay
    ? clamp(overlay.selectedIndex, 0, Math.max(0, filteredOverlayItems.length - 1))
    : 0;

  function openOverlay(kind) {
    const items = kind === "commands" ? commandPaletteItems : contextPaletteItems;
    if (items.length === 0) {
      controller.appendLog(
        "system",
        kind === "commands"
          ? "No hay acciones disponibles para la paleta."
          : "No hay archivos disponibles para el selector de contexto."
      );
      return;
    }

    setOverlay({
      kind,
      query: "",
      selectedIndex: 0,
    });
  }

  function closeOverlay() {
    setOverlay(null);
  }

  function activateOverlayItem(item) {
    if (!item) {
      return;
    }

    if (item.openPalette === "context") {
      setOverlay({
        kind: "context",
        query: "",
        selectedIndex: 0,
      });
      return;
    }

    closeOverlay();
    if (item.command) {
      controller.submitLine(item.command);
    }
  }

  useInput((input, key) => {
    if (snapshot.picker) {
      if (key.ctrl && input === "c") {
        controller.cancelPicker();
        return;
      }

      if (key.escape) {
        controller.cancelPicker();
        return;
      }

      if (key.upArrow) {
        controller.movePicker(-1);
        return;
      }

      if (key.downArrow || key.tab) {
        controller.movePicker(1);
        return;
      }

      if (key.return) {
        controller.submitPicker();
      }
      return;
    }

    if (overlay) {
      if (key.ctrl && input === "c") {
        closeOverlay();
        return;
      }

      if (key.ctrl && input === "u") {
        setOverlay((current) => (current ? {...current, query: "", selectedIndex: 0} : current));
        return;
      }

      if (key.escape) {
        closeOverlay();
        return;
      }

      if (key.upArrow) {
        setOverlay((current) =>
          current
            ? {
                ...current,
                selectedIndex:
                  filteredOverlayItems.length > 0
                    ? (overlaySelectedIndex - 1 + filteredOverlayItems.length) % filteredOverlayItems.length
                    : 0,
              }
            : current
        );
        return;
      }

      if (key.downArrow || key.tab) {
        setOverlay((current) =>
          current
            ? {
                ...current,
                selectedIndex:
                  filteredOverlayItems.length > 0 ? (overlaySelectedIndex + 1) % filteredOverlayItems.length : 0,
              }
            : current
        );
        return;
      }

      if (key.return) {
        activateOverlayItem(filteredOverlayItems[overlaySelectedIndex]);
        return;
      }

      if (key.backspace || key.delete) {
        setOverlay((current) =>
          current
            ? {
                ...current,
                query: current.query.slice(0, -1),
                selectedIndex: 0,
              }
            : current
        );
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setOverlay((current) =>
          current
            ? {
                ...current,
                query: `${current.query}${input}`,
                selectedIndex: 0,
              }
            : current
        );
      }
      return;
    }

    if (key.ctrl && input === "c") {
      const cancelled = controller.cancelLine();
      if (!cancelled) {
        controller.requestExit();
      }
      return;
    }

    if (!snapshot.pending) {
      return;
    }

    if (key.ctrl && input === "l") {
      controller.clearLogs();
      return;
    }

    if (key.ctrl && input === "u") {
      setInputBuffer("");
      setHistoryIndex(-1);
      return;
    }

    if (snapshot.promptKind === "input" && key.ctrl && input === "p") {
      openOverlay("commands");
      return;
    }

    if (snapshot.promptKind === "input" && key.ctrl && input === "o") {
      openOverlay("context");
      return;
    }

    if (snapshot.promptKind === "input" && key.leftArrow) {
      setFocusedArea((current) => moveFocus(focusAreas, current, -1));
      return;
    }

    if (snapshot.promptKind === "input" && key.rightArrow) {
      setFocusedArea((current) => moveFocus(focusAreas, current, 1));
      return;
    }

    if (key.return) {
      if (snapshot.promptKind === "input" && focusedArea === "quick" && quickActions[actionSelection.quick]) {
        controller.submitLine(quickActions[actionSelection.quick].command);
        return;
      }

      if (snapshot.promptKind === "input" && focusedArea === "context" && contextActions[actionSelection.context]) {
        controller.submitLine(contextActions[actionSelection.context].command);
        return;
      }

      const value = inputBuffer.trim();
      if (snapshot.promptKind === "input" && value) {
        setHistory((current) => {
          const next =
            current.length > 0 && current[current.length - 1] === value
              ? current
              : [...current.slice(-19), value];
          return next;
        });
      }
      controller.submitLine(value);
      setInputBuffer("");
      setHistoryIndex(-1);
      setHistoryDraft("");
      return;
    }

    if (key.escape) {
      if (focusedArea !== "input") {
        setFocusedArea("input");
        return;
      }
      setInputBuffer("");
      setHistoryIndex(-1);
      setHistoryDraft("");
      return;
    }

    if (snapshot.promptKind === "input" && focusedArea === "quick" && key.upArrow && quickActions.length > 0) {
      setActionSelection((current) => ({
        ...current,
        quick: (current.quick - 1 + quickActions.length) % quickActions.length,
      }));
      return;
    }

    if (snapshot.promptKind === "input" && focusedArea === "context" && key.upArrow && contextActions.length > 0) {
      setActionSelection((current) => ({
        ...current,
        context: (current.context - 1 + contextActions.length) % contextActions.length,
      }));
      return;
    }

    if (key.upArrow && snapshot.promptKind === "input" && history.length > 0) {
      setHistoryIndex((current) => {
        const nextIndex = current === -1 ? history.length - 1 : Math.max(0, current - 1);
        if (current === -1) {
          setHistoryDraft(inputBuffer);
        }
        setInputBuffer(history[nextIndex] || "");
        return nextIndex;
      });
      return;
    }

    if (snapshot.promptKind === "input" && focusedArea === "quick" && key.downArrow && quickActions.length > 0) {
      setActionSelection((current) => ({
        ...current,
        quick: (current.quick + 1) % quickActions.length,
      }));
      return;
    }

    if (snapshot.promptKind === "input" && focusedArea === "context" && key.downArrow && contextActions.length > 0) {
      setActionSelection((current) => ({
        ...current,
        context: (current.context + 1) % contextActions.length,
      }));
      return;
    }

    if (key.downArrow && snapshot.promptKind === "input" && history.length > 0) {
      setHistoryIndex((current) => {
        if (current === -1) {
          return -1;
        }

        const nextIndex = current + 1;
        if (nextIndex >= history.length) {
          setInputBuffer(historyDraft);
          return -1;
        }

        setInputBuffer(history[nextIndex] || "");
        return nextIndex;
      });
      return;
    }

    if (key.backspace || key.delete) {
      setInputBuffer((current) => current.slice(0, -1));
      setHistoryIndex(-1);
      return;
    }

    if (key.tab) {
      const completed = snapshot.promptKind === "input" ? completeSlashCommand(inputBuffer) : inputBuffer;
      if (completed !== inputBuffer) {
        setInputBuffer(completed);
      } else if (inputBuffer.trim().length === 0) {
        setFocusedArea((current) => moveFocus(focusAreas, current, 1));
      } else {
        setInputBuffer((current) => `${current}  `);
      }
      setHistoryIndex(-1);
      return;
    }

    if (!key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow) {
      if (focusedArea !== "input") {
        setFocusedArea("input");
      }
      setInputBuffer((current) => `${current}${input}`);
      setHistoryIndex(-1);
    }
  });

  const logs = useMemo(() => snapshot.logs, [snapshot.logs]);
  const layout = getResponsiveLayout(dimensions.columns, dimensions.rows);

  return h(
    Box,
    {flexDirection: "column"},
    h(HeaderPanel, {state, model: snapshot.model}),
    layout.compact
      ? h(
          Box,
          {flexDirection: "column"},
          h(BusyPanel, {busy: snapshot.busy, frameIndex}),
          h(ActivityPanel, {logs, maxLogs: layout.maxLogs}),
          h(CompactSupportPanels, {
            state,
            snapshot,
            inputBuffer,
            historySize: history.length,
            quickActions,
            contextActions,
            focusedArea,
            actionSelection,
            layout,
          })
        )
      : h(
          Box,
          {flexDirection: "row", alignItems: "flex-start"},
          h(
            Box,
            {flexDirection: "column", width: layout.mainWidth, marginRight: 1, flexShrink: 0},
            h(BusyPanel, {busy: snapshot.busy, frameIndex}),
            h(ActivityPanel, {logs, maxLogs: layout.maxLogs})
          ),
          h(
            Box,
            {flexDirection: "column", width: layout.sideWidth, flexShrink: 0},
            h(SessionPanel, {state, snapshot}),
            h(
              ActionPanel,
              {
                title: "Acciones",
                items: quickActions,
                focusedArea,
                area: "quick",
                selectedIndex: actionSelection.quick,
                emptyText: "No hay acciones sugeridas.",
              }
            ),
            h(
              ActionPanel,
              {
                title: "Archivos",
                items: contextActions,
                focusedArea,
                area: "context",
                selectedIndex: actionSelection.context,
                emptyText: "No hay archivos sugeridos.",
              }
            ),
            !layout.dense || snapshot.promptKind === "question" || getSlashSuggestions(inputBuffer).length > 0
              ? h(SuggestionsPanel, {inputBuffer, snapshot})
              : null
          )
        ),
    h(PickerPanel, {picker: snapshot.picker}),
    overlay
      ? h(SearchablePalettePanel, {
          title: overlay.kind === "commands" ? "Paleta de comandos" : "Selector de archivos/contexto",
          hint:
            overlay.kind === "commands"
              ? "Busca acciones y ejecutalas al instante."
              : "Busca archivos y agrega o quita contexto con Enter.",
          query: overlay.query,
          items: filteredOverlayItems,
          selectedIndex: overlaySelectedIndex,
          dense: layout.dense,
        })
      : null,
    h(FooterPanel, {snapshot, inputBuffer, historySize: history.length})
  );
}

function createUiAdapter(controller) {
  let startupShown = false;

  return {
    theme: legacyUi.theme,
    paint(text) {
      return String(text ?? "");
    },
    write(text = "") {
      controller.appendLog("output", text);
    },
    writeLine(text = "") {
      controller.appendLog("output", text);
    },
    errorLine(text = "") {
      controller.appendLog("error", text);
    },
    printStartupBanner(_state, model) {
      controller.setModel(model);
      if (!startupShown) {
        controller.appendLog(
          "system",
          "LM Code listo. Escribe prompts o comandos slash. Ctrl+C para salir."
        );
        startupShown = true;
      }
    },
    async readFancyInput(_state, model) {
      controller.setModel(model);
      return controller.requestLine("input");
    },
    async askPlainQuestion(promptText) {
      controller.appendLog("system", promptText);
      return (await controller.requestLine("question", promptText)) ?? "";
    },
    async chooseOption(config) {
      return controller.openPicker(config);
    },
    async runWithSpinner(model, label, task) {
      controller.setModel(model);
      controller.setBusy({
        model,
        label,
        startedAt: Date.now(),
      });

      try {
        return await task();
      } finally {
        controller.setBusy(null);
      }
    },
    sanitizeConsoleResponse: legacyUi.sanitizeConsoleResponse,
    setModel(model) {
      controller.setModel(model);
    },
  };
}

export async function runReactInteractive(state, model, deps) {
  const controller = createController(model);
  const uiAdapter = createUiAdapter(controller);
  const app = render(h(ReactCliApp, {controller, state}), {
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });

  Promise.resolve()
    .then(() => deps.runInteractive(state, model, uiAdapter))
    .catch((error) => {
      controller.appendLog("error", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      controller.requestExit();
    });

  await app.waitUntilExit();
}
