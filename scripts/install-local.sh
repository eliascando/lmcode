#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET_PATH="${TARGET_DIR}/lmcode"

mkdir -p "${TARGET_DIR}"
cp "${ROOT_DIR}/bin/lmcode.js" "${TARGET_PATH}"
chmod +x "${TARGET_PATH}"

printf 'Instalado en %s\n' "${TARGET_PATH}"
