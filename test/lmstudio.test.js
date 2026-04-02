const test = require("node:test");
const assert = require("node:assert/strict");

const lmstudio = require("../src/lmstudio");

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test("chooseModel uses visual chooser when available", async () => {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options = {}) => {
    requests.push({url, options});

    if (url.endsWith("/api/v1/models")) {
      return jsonResponse({
        models: [
          {
            key: "alpha",
            type: "llm",
            display_name: "Alpha",
            loaded_instances: [{context_length: 4096}],
          },
          {
            key: "beta",
            type: "llm",
            display_name: "Beta",
            loaded_instances: [],
          },
        ],
      });
    }

    if (url.endsWith("/api/v1/models/load")) {
      return jsonResponse({
        load_config: {context_length: 8192},
        load_time_seconds: 1.2,
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const ui = {
      writes: [],
      writeLine(line) {
        this.writes.push(line);
      },
      async chooseOption(config) {
        assert.equal(config.title, "Elige un modelo");
        assert.equal(config.selectedIndex, 0);
        assert.equal(config.options.length, 2);
        return config.options[1];
      },
    };

    const selected = await lmstudio.chooseModel("http://127.0.0.1:1234", "", true, ui, true);

    assert.deepEqual(selected, {
      key: "beta",
      contextLength: 8192,
    });
    assert.equal(
      requests.some((entry) => entry.url.endsWith("/api/v1/models/load")),
      true
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("chooseModel keeps current selection when visual chooser is cancelled", async () => {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options = {}) => {
    requests.push({url, options});

    if (url.endsWith("/api/v1/models")) {
      return jsonResponse({
        models: [
          {
            key: "alpha",
            type: "llm",
            display_name: "Alpha",
            loaded_instances: [{context_length: 4096}],
          },
          {
            key: "beta",
            type: "llm",
            display_name: "Beta",
            loaded_instances: [],
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const ui = {
      writeLine() {},
      async chooseOption() {
        return null;
      },
    };

    const selected = await lmstudio.chooseModel("http://127.0.0.1:1234", "", true, ui, true);

    assert.deepEqual(selected, {
      key: "alpha",
      contextLength: 4096,
    });
    assert.equal(
      requests.some((entry) => entry.url.endsWith("/api/v1/models/load")),
      false
    );
  } finally {
    global.fetch = originalFetch;
  }
});
