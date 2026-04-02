const { env } = require("node:process");

const { DEFAULT_CONTEXT_WINDOW_TOKENS } = require("./config");

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

function printModels(ui, models) {
  if (!models.length) {
    ui.writeLine("No se encontraron modelos LLM.");
    return;
  }

  for (const model of models) {
    ui.writeLine(`${model.key}  [${modelStateLabel(model)}]  ${model.display_name || ""}`);
  }
}

async function chooseModel(baseUrl, requestedModel, interactive, ui, forcePrompt = false) {
  const models = await fetchModels(baseUrl);
  const loaded = loadedModels(models);

  async function ensureLoaded(model) {
    if (modelLoadedCount(model) > 0) {
      return {
        key: model.key,
        contextLength: modelContextLength(model) || DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
    }

    ui.writeLine(`Cargando modelo ${model.key}...`);
    const result = await requestJson(baseUrl, "/api/v1/models/load", "POST", {
      model: model.key,
      context_length: DEFAULT_CONTEXT_WINDOW_TOKENS,
      echo_load_config: true,
    });
    const contextLength =
      result?.load_config?.context_length || DEFAULT_CONTEXT_WINDOW_TOKENS;
    ui.writeLine(
      `Modelo cargado: ${model.key} · ${contextLength} tok · ${result?.load_time_seconds || "?"}s`
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

    ui.writeLine("Modelos disponibles:");
    sorted.forEach((model, index) => {
      const marker = model.key === currentModel ? "*" : " ";
      ui.writeLine(
        `${marker}${index + 1}. ${model.key} [${modelStateLabel(model)}] ${model.display_name || ""}`
      );
    });

    const selectedIndex = Math.max(0, sorted.findIndex((model) => model.key === currentModel));

    if (typeof ui.chooseOption === "function") {
      const picked = await ui.chooseOption({
        title: "Elige un modelo",
        hint: "Modelos cargados primero. Enter confirma; Esc mantiene el actual.",
        selectedIndex,
        options: sorted.map((model) => ({
          label: model.key,
          description: `[${modelStateLabel(model)}] ${model.display_name || ""}`.trim(),
          model,
        })),
      });
      return picked?.model || sorted[selectedIndex];
    }

    const answer = (await ui.askPlainQuestion(`Modelo [${selectedIndex + 1}]: `)).trim();
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

async function switchModel(
  baseUrl,
  currentModelKey,
  requestedModel,
  interactive,
  ui,
  forcePrompt = false
) {
  const selected = await chooseModel(baseUrl, requestedModel, interactive, ui, forcePrompt);

  if (!currentModelKey || currentModelKey === selected.key) {
    return selected;
  }

  try {
    const models = await fetchModels(baseUrl);
    const previous = matchModel(models, currentModelKey);
    const previousInstanceId = modelInstanceId(previous);

    if (previous && previousInstanceId) {
      ui.writeLine(`Descargando modelo anterior ${currentModelKey}...`);
      await unloadModel(baseUrl, previousInstanceId);
      ui.writeLine(`Modelo descargado: ${currentModelKey}`);
    }
  } catch (error) {
    ui.errorLine(
      `No pude descargar el modelo anterior ${currentModelKey}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return selected;
}

module.exports = {
  chatCompletion,
  chooseModel,
  fetchModels,
  printModels,
  switchModel,
};
