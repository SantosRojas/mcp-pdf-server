# MCP PDF Server

Servidor MCP empresarial para crear, validar, combinar y proteger documentos PDF a partir de un AST JSON declarativo. Está orientado a agentes de IA que generan informes ejecutivos, reportes técnicos, documentos financieros y propuestas sin emitir HTML/CSS ni ejecutar código arbitrario.

## Qué incluye

- **7 herramientas MCP pensadas para agentes de IA:** `get_pdf_server_info`, `list_pdf_components`, `validate_pdf_ast`, `generate_pdf`, `list_pdfs`, `merge_pdfs` y `apply_pdf_security`.
- **Multiplataforma (Windows, macOS y Linux):** normalización de separadores (`/` y `\`), expansión de `~`, resolución canónica de symlinks (`/tmp` → `/private/tmp` en macOS, rutas 8.3 en Windows), escritura atómica con fallback para sistemas de archivos sin hard links, flags CLI multiplataforma (`--transport=http`, `--output-dir`, `--allow-dir`, `--allow-any-path`) y autodetección de `qpdf` en Windows (Program Files/Scoop/Chocolatey), macOS (Homebrew/MacPorts) y Linux (`/usr/bin`, `/usr/local/bin`, `/snap/bin`).
- **Localización flexible en el proyecto activo:** soporta la capacidad **`roots` del protocolo MCP** (`roots/list` y `notifications/roots/list_changed`) además de `process.cwd()`, permitiendo guardar PDFs en cualquier carpeta del proyecto donde se esté usando el MCP (`outputDir: "."`, `"reports/2026"`, rutas absolutas dentro del proyecto o directorios adicionales en `PDF_MCP_ALLOWED_DIRS`).
- **Motor basado en React PDF:** `@react-pdf/renderer` con salida vectorial, paginación, sistema de tokens de diseño (`src/engine/design.ts`) y tipografía editorial con **Inter** (400/600/700 + cursivas) y **JetBrains Mono** (con ligaduras desactivadas para copia literal de código) activadas por defecto.
- **AST estricto:** Zod 4 (strict objects), límites de tamaño, tipos y validaciones de contenido; esquema JSON Schema generado desde el propio contrato; no existe `eval`, scripting, HTML o CSS arbitrario.
- **20 componentes de dominio:** layout, encabezados, texto enriquecido, callouts, tablas, KPIs, gráficos con escala y grilla en eje Y, diagramas de flujo vectoriales, código resaltado con modos claro/oscuro de alto contraste, imágenes, QR, firmas, resumen de factura y listas.
- **Temas predefinidos y combinación tipográfica:** `corporate_blue`, `modern_minimal`, `executive_dark`, `financial_classic` y `technical_docs`, con soporte opcional para `theme.headingFontFamily` y paletas de gráficos/callouts/diagramas derivadas dinámicamente del tema.
- **Composición PDF:** listado, unión de documentos y edición de metadatos con `pdf-lib`.
- **Cifrado/permisos:** qpdf AES-256 para contraseña de usuario/propietario y permisos de impresión/extracción.
- **Activos:** conversión PNG/JPEG/WebP/SVG a PNG, timeout, límite de bytes, bloqueo de IP privadas y placeholder cuando una imagen falla.
- **Transporte:** stdio para clientes locales y Streamable HTTP para despliegues remotos. Streamable HTTP es el transporte remoto recomendado en la línea actual del SDK; no se habilita el antiguo SSE de compatibilidad.
- **Contenedores:** Docker y Podman mediante Dockerfile/Compose.

## Requisitos

- Node.js **20.9+** (se recomienda Node 22 LTS).
- npm 10+.
- qpdf (solo para cifrar/restringir PDFs; opcional en modo de solo generación y merge).

### Instalación local

```bash
unzip mcp-pdf-server.zip
cd mcp-pdf-server
cp .env.example .env
npm install
npm run build
npm test
npm start
```

El proceso carga automáticamente las variables desde `.env` (sin sobrescribir variables ya definidas por el entorno). `npm start` inicia el transporte stdio y mantiene `stdout` reservado para JSON-RPC. Los logs van a `stderr`.

Para usar el cifrado:

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y qpdf

# Alpine
sudo apk add qpdf

# RHEL / AlmaLinux (según repositorios habilitados)
sudo dnf install -y qpdf
```

## Transporte HTTP remoto

El transporte remoto usa MCP Streamable HTTP. El servidor conserva el modo stdio para clientes locales y añade MCP Streamable HTTP con sesiones para despliegues remotos. No expongas el proceso directamente a Internet sin autenticación, TLS y un proxy/reverse proxy correctamente configurado.

```bash
cp .env.example .env
```

Configura en `.env` al menos:

```dotenv
PDF_MCP_TRANSPORT=http
PDF_MCP_HOST=0.0.0.0
PDF_MCP_PORT=3333
PDF_MCP_HTTP_PATH=/mcp
PDF_MCP_AUTH_TOKEN=REEMPLAZAR_POR_UN_TOKEN_ALEATORIO_LARGO
PDF_MCP_ALLOWED_HOSTS=localhost,127.0.0.1,::1,pdf-mcp.midominio.local
PDF_MCP_ALLOWED_ORIGINS=https://mi-cliente.midominio.local
```

Inicia:

```bash
npm run build
npm run start:http
```

Endpoint MCP: `http://127.0.0.1:3333/mcp`
Health check: `http://127.0.0.1:3333/healthz`

Autenticación HTTP: `Authorization: Bearer <PDF_MCP_AUTH_TOKEN>`. Para un despliegue público, coloca Nginx/Traefik/Caddy delante y termina TLS en ese proxy. Mantén `PDF_MCP_ALLOWED_HOSTS` y `PDF_MCP_ALLOWED_ORIGINS` en allowlists exactas.

## Docker / Podman

El contenedor incluye Node 22, qpdf, carga `env_file: .env` y ejecuta con el usuario no privilegiado `node`. Por defecto el puerto se publica solo en loopback del host.

```bash
cp .env.example .env
# Edita .env y define PDF_MCP_AUTH_TOKEN

docker compose up -d --build
# o
podman compose up -d --build
```

Comprueba:

```bash
curl http://127.0.0.1:3333/healthz
```

Para que otro contenedor de la misma red se conecte, usa el DNS del servicio `mcp-pdf:3333` y configura el nombre que llegue en `Host` dentro de `PDF_MCP_ALLOWED_HOSTS`. El servicio Compose publicado al host queda ligado a `127.0.0.1` deliberadamente; usa un reverse proxy o una red privada para conexiones remotas.

## Conectar desde clientes MCP

### OpenCode (configuración portable entre proyectos)

Instala el comando una sola vez:

```bash
npm install
npm run build
npm link
```

Después, el mismo `opencode.json` funciona en cualquier proyecto:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "pdf": {
        "type": "local",
        "command": ["cmd", "/c", "mcp-pdf-server"]
      }
    }
  }
}
```

En macOS/Linux usa `"command": ["mcp-pdf-server"]`. Si prefieres no usar `npm link`, la alternativa es `"command": ["node", "C:\\ruta\\mcp-pdf-server\\dist\\index.js"]`.

Cómo se resuelven las rutas desde cualquier proyecto (Windows, macOS y Linux):

- **Detección automática del proyecto activo (`MCP roots` + `cwd`):** si el cliente MCP anuncia `roots` (`roots/list`), el servidor toma esa carpeta como raíz del proyecto aunque el proceso se haya lanzado desde otra ubicación global; si el cliente no envía `roots`, usa `process.cwd()`.
- **Guardar en cualquier carpeta del proyecto:**
  - Sin `outputDir`: los PDFs se guardan por defecto en **`<proyecto>/output`**.
  - `outputDir: "."`: guarda directamente en la **raíz del proyecto**.
  - `outputDir: "reports/2026"` (o cualquier ruta relativa con `/` o `\`): crea y usa esa subcarpeta dentro del proyecto.
  - `outputDir` absoluto: permitido siempre que esté dentro del proyecto o de las carpetas autorizadas.
- **Carpetas adicionales fuera del proyecto:** define `PDF_MCP_ALLOWED_DIRS` (admite `;` y `:` como separador en Windows, macOS y Linux, además de `~`) o pasa `--allow-dir=/ruta` al comando. En entornos locales de confianza puedes habilitar `PDF_MCP_ALLOW_ANY_PATH=true` (o `--allow-any-path`) para permitir cualquier ruta del sistema.
- **Centralizar la salida por defecto:** define `PDF_MCP_OUTPUT_DIR` (o `--output-dir=...`) con una ruta relativa al proyecto o absoluta.
- `.env`, `assets/` y `assets/fonts/` se leen **de la instalación del servidor**, no del proyecto que lo invoca. El `.env` del proyecto cliente se ignora a propósito para no mezclar secretos ajenos (`DOTENV_CONFIG_PATH` permite indicar otro archivo).
- Si prefieres no copiar nada, declara este servidor una sola vez en la configuración global `~/.config/opencode/opencode.json`.

### Cliente stdio genérico (Claude Desktop, Cursor, VS Code, OpenCode, etc.)

Configura el comando y, opcionalmente, las rutas que quieras sobrescribir:

```json
{
  "mcpServers": {
    "pdf": {
      "command": "node",
      "args": ["/ruta/absoluta/mcp-pdf-server/dist/index.js"],
      "env": {
        "PDF_MCP_TRANSPORT": "stdio",
        "PDF_MCP_OUTPUT_DIR": "/ruta/donde/quieras/los/pdfs",
        "PDF_MCP_ASSET_DIR": "/ruta/absoluta/mcp-pdf-server/assets"
      }
    }
  }
}
```

Ejemplo también disponible en `examples/mcp-client-config.json`.

### Cliente HTTP

Conecta el cliente MCP compatible con Streamable HTTP a:

```text
https://pdf-mcp.midominio.local/mcp
```

Envía el bearer token configurado en `PDF_MCP_AUTH_TOKEN`.

## Flujo recomendado para un agente IA

1. Invoca `get_pdf_server_info` al inicio de la sesión para conocer la raíz del proyecto activo (`workspace.primaryRoot`), la carpeta de salida por defecto (`output.directory`), las carpetas permitidas (`output.allowedRoots`), las fuentes instaladas y la disponibilidad de `qpdf`.
2. Invoca `list_pdf_components` con la categoría necesaria (o `all`) para descubrir el catálogo y el esquema.
3. Construye un AST JSON con componentes estructurados. No generes HTML ni estilos arbitrarios.
4. Invoca `validate_pdf_ast` con el documento completo.
5. Corrige todos los errores y considera las advertencias (p. ej. columnas ausentes o imágenes externas). La validación comprueba la sintaxis de las URLs, pero no realiza peticiones de red; la descarga se intenta durante la generación y cualquier fallo deja un placeholder.
6. Invoca `generate_pdf` indicando `outputDir` si el usuario pidió una carpeta específica del proyecto (por ejemplo `"."` o `"docs/informes"`), y conserva `path`, `relativePath`, `pages`, `bytes` y `warnings` de la respuesta.
7. Para localizar PDFs ya creados en el proyecto usa `list_pdfs`; para documentos compuestos usa `merge_pdfs` (que también acepta `outputDir`).
8. Para distribuir documentos protegidos usa `apply_pdf_security` con una contraseña de propietario de al menos 8 caracteres y preferiblemente una frase larga.

El agente debería tratar el PDF generado como un artefacto que debe verificarse: abrir/renderizar una muestra, revisar número de páginas, tablas, imágenes y márgenes antes de distribuirlo.

## Esquema del AST

Cada elemento es un objeto JSON con `type` y propiedades declaradas. Los contenedores reciben `children`. Ejemplo mínimo:

```json
{
  "filename": "reporte-demo",
  "settings": { "pageSize": "A4", "orientation": "portrait" },
  "theme": { "preset": "corporate_blue" },
  "metadata": { "title": "Reporte de ejemplo", "author": "Área de Datos" },
  "fixedHeader": { "text": "REPORTE INTERNO" },
  "fixedFooter": { "showPageNumbers": true },
  "content": [
    { "type": "DocumentHeader", "title": "Reporte comercial", "subtitle": "Período noviembre 2026" },
    { "type": "Grid", "columns": 2, "children": [
      { "type": "MetricCard", "label": "Venta neta", "value": "S/ 125,000", "trend": "+8%" },
      { "type": "MetricCard", "label": "Unidades", "value": 2450 }
    ] },
    { "type": "SectionTitle", "number": 1, "title": "Detalle" },
    { "type": "Text", "text": "El desempeño fue **positivo** durante el período." },
    { "type": "DataTable", "columns": [
      { "key": "sku", "label": "SKU" },
      { "key": "venta", "label": "Venta", "format": "currency", "align": "right" }
    ], "rows": [{ "sku": "SKU-001", "venta": 1200.5 }] }
  ]
}
```

Los ejemplos completos están en `examples/monthly-sales-report.json` y `examples/invoice-example.json`. Para recomendaciones sobre cómo instruir al agente, minimizar tokens y revisar el resultado, consulta `docs/LLM-AGENT-GUIDE.md`.

### Componentes y propiedades

| Categoría | Componente | Uso |
|---|---|---|
| Layout | `PageBreak`, `View`, `Grid`, `Spacer`, `Divider` | Paginación, flex, grillas y espaciado |
| Tipografía | `DocumentHeader`, `SectionTitle` (numeración secuencial con `autoNumber`), `Text`, `Callout`, `BulletList` | Jerarquía, texto enriquecido y avisos |
| Datos | `DataTable` (moneda y locale configurables), `KeyValueList`, `MetricCard`, `InvoiceSummary`, `SignatureBlock` | Tablas, metadatos, KPIs, totales y firmas |
| Visualización | `Chart`, `Flowchart` | Gráficos bar, line, pie y doughnut; diagramas de flujo con auto-layout por capas |
| Técnico | `CodeBlock` | SQL, Python, JSON, JavaScript, TypeScript, Bash, YAML y texto |
| Media | `Image`, `QRCode` | Imágenes normalizadas y QR |

Cada `SectionTitle` admite `autoNumber: true` para numerar secuencialmente los títulos que no tengan un `number` explícito. Para descubrir las propiedades exactas consulta `list_pdf_components`; el JSON Schema generado se devuelve junto al catálogo.

## Imágenes y seguridad

- Las rutas locales son relativas a `PDF_MCP_ASSET_DIR`. No se permiten rutas absolutas ni `..`.
- Los `data:` URI aceptados son PNG/JPEG/WebP/SVG en Base64.
- Las imágenes remotas están deshabilitadas por defecto. Para habilitarlas define `PDF_MCP_ALLOW_REMOTE_IMAGES=true`.
- Las imágenes remotas solo admiten HTTPS y se comprueba DNS contra rangos privados/reservados, se fija la IP de descarga y se vuelven a comprobar las redirecciones.
- Timeout predeterminado: 5 segundos. Límite predeterminado: 8 MiB por imagen, 40 fuentes únicas y 40 MiB agregados por documento. Se usa `sharp` para rasterizar y normalizar a PNG.
- Si una imagen no se puede cargar, el PDF muestra `[Imagen no disponible]` y la generación continúa.
- El output y los PDFs de entrada de las herramientas de merge/security están aislados en `PDF_MCP_OUTPUT_DIR`. El merge limita la entrada agregada a 250 MiB y 2500 páginas; el AST limita su tamaño y profundidad, y los QR únicos por documento a 100.
- La autenticación de HTTP no sustituye TLS ni una red privada. No publiques el puerto sin un proxy TLS y reglas de firewall.

## Paginación y fidelidad

- Las tarjetas KPI, callouts, firmas, imágenes y filas de tabla se mantienen indivisibles (`wrap=false`).
- `CodeBlock` ajusta la tipografía del bloque al ancho disponible y solo envuelve la línea cuando ya no puede reducirse; las líneas se mantienen juntas verticalmente. La numeración se dibuja como geometría vectorial, por lo que copiar el bloque desde el PDF nunca arrastra los números de línea. Para obtener el fuente literal (sin los cortes que impone el ancho de página) usa `settings.codeExport: "sidecar" | "embedded" | "both"`.
- Los `SectionTitle` usan `minPresenceAhead`, por lo que un título nunca queda huérfano al pie de página.
- Las tablas que caben en una página se mantienen indivisibles y dibujan su cabecera una sola vez. Solo las tablas que superan el alto de página usan cabecera `fixed`, que React-PDF repite en las páginas de continuación; en ese caso conviene ubicar tablas extensas al final de una sección o insertar un `PageBreak` al terminar la tabla si no deben aparecer en páginas posteriores. Las filas individuales no se parten entre páginas.
- La cabecera/pie general se repite en todas las páginas y admite paginación `Página n de N`.

## Seguridad PDF y metadatos

`apply_pdf_security` utiliza `pdf-lib` para metadatos y `qpdf` para cifrado AES-256:

- `permissions.printing=false` bloquea impresión.
- `permissions.copying=false` bloquea extracción/copia.
- `ownerPassword` es obligatorio para cifrado o restricciones.
- qpdf recibe contraseñas a través de argumentos del proceso; limita el acceso al host/namespace y ejecuta el servicio con una cuenta de sistema dedicada. Para entornos con requisitos de secreto de proceso más estrictos, usa un wrapper de qpdf que lea credenciales desde un descriptor protegido.

Por defecto la herramienta conserva impresión y copia; para restringirlos debes indicar explícitamente `false`. Las restricciones de PDF son controles de interoperabilidad, no DRM absoluto: un lector o herramienta que ignore permisos puede no respetarlas.

## Fuentes y sistema de estilos

Se incluyen y activan por defecto dos familias libres bajo SIL Open Font License, con sus archivos de licencia en `assets/fonts`:

- **Inter** (`theme.fontFamily: "Inter"`, predeterminada) para cuerpo, subtítulos, tablas y encabezados (Regular 400, Italic 400, SemiBold 600, Bold 700, BoldItalic 700).
- **JetBrains Mono** para `CodeBlock` y `` `código inline` `` (Regular 400, Italic 400, Bold 700), con las ligaduras OpenType (`calt`, `liga`, `clig`, `dlig`, `rlig`) desactivadas para que operadores como `<=`, `<>`, `>=`, `!=` y `=>` se copien literalmente como ASCII.

Además:

- `theme.headingFontFamily` permite combinar una fuente distinta para títulos, encabezados de tabla y KPIs (por ejemplo, `Times-Roman` en títulos e `Inter` en cuerpo).
- `Text.weight` admite `"normal" | "semibold" | "bold"` (400, 600 y 700).
- Las familias `Helvetica`, `Times-Roman` y `Courier` siguen disponibles como base, y `Roboto` se activa automáticamente si se añaden sus `.ttf` en `assets/fonts`. Si la familia pedida no está instalada, la respuesta incluye un `warning` con el reemplazo aplicado. Para más detalles, consulta `assets/fonts/README.md`.

## Pruebas y desarrollo

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke
npm start
```

`npm run smoke` ejecuta tres pruebas end-to-end contra `dist/`: `tests/e2e-smoke.mjs` (stdio: catálogo, validación, generación, unión, metadatos, cifrado AES-256 con qpdf, sandbox y saltos de página), `tests/cwd-smoke.mjs` (el servidor arranca desde carpetas ajenas: usa su propio `.env`/assets y escribe en `<workspace>/output`) y `tests/http-smoke.mjs` (Streamable HTTP: health check, bearer token y generación). Las comprobaciones que dependen de qpdf se omiten si no está instalado.

Prueba MCP con:

```bash
npm run inspect
```

Los tests cubren validación de AST, propiedades no permitidas, reglas de seguridad de archivos, validación de datos de gráficos y catálogo de componentes.

## Límites conocidos / siguientes extensiones

- No se implementa conversión OCR, edición directa de texto existente ni firma digital criptográfica. `SignatureBlock` es un bloque de firma visual, no una firma digital con certificado.
- Los gráficos bar/line admiten hasta seis series (barras agrupadas y líneas superpuestas); pie/doughnut usan el primer dataset, ya que representan una sola distribución.
- El renderer no ejecuta scripts del modelo. La personalización visual se realiza mediante temas y propiedades validadas del AST.
- El servidor no hace llamadas a un LLM ni guarda prompts; la orquestación la realiza el cliente MCP/agente.
