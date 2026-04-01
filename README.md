# lmcode

CLI local para programar contra LM Studio.

Ahora el flujo normal funciona como un agente iterativo: puede leer archivos, listar, buscar texto, ejecutar comandos seguros, escribir cambios y cerrar con una respuesta final, en vez de responder una sola vez.

Este proyecto se extrajo desde la instalacion activa en `~/.local/bin/lmcode` para que el codigo viva en un repo real y se pueda seguir desarrollando desde aqui.

## Estructura

- `bin/lmcode.js`: wrapper ejecutable del comando
- `src/cli.js`: orquestacion principal del CLI
- `src/agent.js`: loop del agente y protocolo de herramientas
- `src/core.js`: estado de sesion, workspace, contexto y deteccion de archivos
- `src/lmstudio.js`: cliente y seleccion de modelos de LM Studio
- `src/apply.js`: generacion, parseo y aplicacion de cambios
- `src/ui.js`: salida de terminal, spinner e input
- `test/`: pruebas sobre seleccion implicita, refresh del workspace y apply
- `scripts/install-local.sh`: copia el CLI de este repo a `~/.local/bin/lmcode`

## Uso

```bash
npm run check
npm test
npm start
npm run models
```

## Comportamiento

- Un prompt normal entra al loop de agente.
- El modelo puede pedir `READ`, `LIST`, `GREP`, `RUN`, `FILE`, `DELETE` o `FINAL`.
- Los comandos peligrosos y el borrado piden confirmacion.
- Los cambios de archivos se aplican automaticamente con diff visible.

## Reinstalar el comando global local

```bash
npm run install:local
```

## Nota

Por ahora el binario instalado original se dejo intacto. Este repo ya contiene una copia funcional para seguir trabajando sin editar directamente `~/.local/bin/lmcode`.
