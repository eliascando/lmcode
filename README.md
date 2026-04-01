# lmcode

CLI local para programar contra LM Studio.

Este proyecto se extrajo desde la instalacion activa en `~/.local/bin/lmcode` para que el codigo viva en un repo real y se pueda seguir desarrollando desde aqui.

## Estructura

- `bin/lmcode.js`: CLI actual
- `scripts/install-local.sh`: copia el CLI de este repo a `~/.local/bin/lmcode`

## Uso

```bash
npm run check
npm start
npm run models
```

## Reinstalar el comando global local

```bash
npm run install:local
```

## Nota

Por ahora el binario instalado original se dejo intacto. Este repo ya contiene una copia funcional para seguir trabajando sin editar directamente `~/.local/bin/lmcode`.
