# lmcode

CLI de agente de programacion local para LM Studio.

`lmcode` trabaja sobre el proyecto actual y puede leer archivos, buscar texto, ejecutar comandos seguros, modificar codigo y pedir confirmacion solo para acciones peligrosas como borrado o comandos destructivos.

## Requisitos

- Node.js 18 o superior
- LM Studio instalado
- El servidor local de LM Studio levantado
- Al menos un modelo cargado en LM Studio

Por defecto `lmcode` usa `http://127.0.0.1:1234`.

## Instalacion

### Desde npm

```bash
npm install -g @ecando/lmcode
```

### Desde este repo

```bash
npm install
npm run check
npm test
npm link
```

Si no quieres usar `npm link`, puedes instalar el binario localmente con:

```bash
npm run install:local
```

## Ejecucion

### Ver modelos detectados

```bash
lmcode --models
```

### Modo interactivo

```bash
lmcode
```

### Prompt unico

```bash
lmcode "analiza este proyecto y dime los riesgos principales"
```

### Forzar modelo

```bash
lmcode --model qwen/qwen3.5-9b
lmcode --model qwen/qwen3.5-9b "explica este modulo"
```

### Cambiar URL o system prompt por comando

```bash
lmcode --base-url http://127.0.0.1:1234 --model qwen/qwen3.5-9b
lmcode --system "Eres un agente local experto en Node.js" "revisa este repo"
```

### Agregar archivos iniciales al contexto

```bash
lmcode --add src/app.js --add package.json "explica la arquitectura"
```

## Configuracion

Puedes configurar `lmcode` con variables de entorno.

### URL del servidor LM Studio

```bash
export LMSTUDIO_BASE_URL="http://127.0.0.1:1234"
```

### Modelo por defecto

```bash
export LMSTUDIO_MODEL="qwen/qwen3.5-9b"
```

Tambien se acepta `OPENAI_MODEL`.

### API key opcional

Si tu servidor local requiere token:

```bash
export LMSTUDIO_API_KEY="tu-token"
```

Tambien se aceptan `OPENAI_API_KEY` y `API_KEY`.

### System prompt

```bash
export SYSTEM_PROMPT="Eres un agente local experto en TypeScript y React."
```

### Ventana de contexto

```bash
export LMCODE_CONTEXT_TOKENS=8192
```

Tambien se aceptan `LMSTUDIO_CONTEXT_TOKENS` y `CONTEXT_WINDOW`.

### Desactivar color

```bash
export NO_COLOR=1
```

## Comandos interactivos

- `/help`: muestra ayuda corta
- `/models`: lista modelos
- `/model`: selector interactivo de modelo
- `/model <id>`: cambia o carga un modelo por id
- `/load`: alias de `/model`
- `/load <id>`: carga un modelo por id
- `/files [filtro]`: lista archivos del proyecto
- `/add <ruta>`: agrega archivos al contexto manual
- `/drop <ruta>`: quita archivos del contexto
- `/context`: muestra el contexto actual
- `/read <ruta>`: muestra un archivo
- `/run <comando>`: ejecuta un comando y guarda la salida en contexto
- `/patch <inst>`: pide un diff unificado
- `/apply <inst>`: propone cambios y los aplica
- `/summary`: muestra el resumen acumulado
- `/compact`: fuerza compactacion del historial
- `/clear`: limpia la conversacion
- `/reset`: reinicia conversacion, archivos y salida de comandos
- `/exit`: sale

## Como trabaja el agente

En el flujo normal, `lmcode` entra a un loop de agente. El modelo puede:

- leer archivos
- listar archivos
- buscar texto
- ejecutar comandos seguros
- escribir archivos
- pedir borrado con confirmacion
- cerrar con una respuesta final

Los cambios de codigo se aplican mostrando diff. Los comandos peligrosos y el borrado requieren aprobacion.

## Desarrollo

```bash
npm install
npm run check
npm test
```

## Preparacion para npm

Antes de publicar:

```bash
npm run check
npm test
npm run pack:check
```

Luego inicia sesion y publica:

```bash
npm login
npm publish
```

Si quieres revisar exactamente lo que saldra al registro:

```bash
npm pack --dry-run
```

## Nombre publicado

El paquete se publica como `@ecando/lmcode`, pero el comando instalado sigue siendo:

```bash
lmcode
```
