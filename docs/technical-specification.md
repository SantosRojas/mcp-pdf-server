# Especificación Técnica: Servidor MCP Empresarial para Generación de PDF Basado en Componentes

## 1. Resumen del Proyecto

Desarrollar un servidor **Model Context Protocol (MCP)** de nivel de producción que dote a los LLMs de un ecosistema completo para la generación, manipulación y validación de documentos PDF complejos. El sistema abandona la generación de HTML/CSS crudo en favor de una arquitectura de **Componentes Estructurados (AST en JSON)** que se compilan de forma segura mediante React y `@react-pdf/renderer`.

### 1.1. Pilares Arquitectónicos

* **Eficiencia Extrema de Tokens:** Uso de componentes de dominio de alto nivel (`DataTable`, `Chart`, `CodeBlock`, `InvoiceSummary`) que encapsulan lógica de diseño compleja.

* **Determinismo y Paginación Inteligente:** Control estricto sobre saltos de página (`break`, `wrap={false}`), cabeceras/pies fijos y márgenes dinámicos.

* **Seguridad Zero-Eval:** El LLM envía un Árbol de Sintaxis Abstracta (AST) en JSON validado estrictamente con `zod`, eliminando cualquier riesgo de ejecución de código arbitrario.

* **Ecosistema Multi-Herramienta:** No solo genera PDFs; permite al LLM inspeccionar componentes disponibles, validar esquemas antes de renderizar y gestionar activos (fuentes/imágenes).

## 2. Stack Tecnológico Requerido

* **Runtime & Lenguaje:** Node.js (v20+) con TypeScript (Strict Mode).

* **Protocolo MCP:** `@modelcontextprotocol/sdk` (Soporte para `StdioServerTransport` y preparado para `SSE`).

* **Motor de Renderizado:** `@react-pdf/renderer` + `react` (v18+).

* **Validación de Esquemas:** `zod` y `zod-to-json-schema`.

* **Utilidades Gráficas, Código y Extra:**

  * `lowlight` o `prismjs` (Para tokenizar código fuente —SQL, Python, JSON, Bash— en un árbol AST que pueda traducirse a componentes `<Text>` con colores de resaltado de sintaxis sin depender del DOM).

  * `qrcode` (Generación de códigos QR en base64/SVG para incrustar en PDFs).

  * `pdf-lib` (Para post-procesamiento: unir PDFs, añadir contraseñas/encriptación o metadatos avanzados).

  * `quickchart-js` o generación de SVG nativo (Para gráficos de barras/líneas/pastel vectoriales dentro del PDF).

  * `sharp` (Para sanitización y conversión de imágenes WebP/SVG a PNG).

## 3. Ecosistema de Herramientas MCP (Tools)

Para cubrir cualquier escenario profesional, el servidor debe exponer **5 herramientas especializadas** en lugar de una sola:

### 3.1. `list_pdf_components`

* **Propósito:** Permite al LLM consultar dinámicamente el catálogo de componentes disponibles, sus propiedades requeridas, opcionales y ejemplos de uso. Esto evita que el modelo "alucine" propiedades que no existen.

* **Input:** `{ category?: "layout" | "data" | "technical" | "media" | "typography" | "all" }`

* **Output:** Documentación estructurada en JSON de los componentes y sus props.

### 3.2. `validate_pdf_ast`

* **Propósito:** Permite al LLM hacer un *dry-run* (prueba en seco) de su estructura JSON antes de renderizar el archivo pesado. Verifica errores de tipos, URLs rotas o problemas de estructura.

* **Input:** El mismo esquema AST de `generate_pdf`.

* **Output:** `{ valid: boolean, errors?: Array<{ path: string, message: string }> }`.

### 3.3. `generate_pdf` (Herramienta Principal)

* **Propósito:** Compila el AST en JSON, aplica el tema seleccionado, renderiza el PDF y opcionalmente aplica seguridad/metadatos.

* **Input:** Ver sección 5 (Esquema Maestro).

* **Output:** Ruta del archivo generado, número de páginas totales, peso del archivo y confirmación.

### 3.4. `merge_pdfs`

* **Propósito:** Permite combinar múltiples PDFs generados (ej. unir una portada, un reporte dinámico y unos términos y condiciones estáticos) usando `pdf-lib`.

* **Input:** `{ filePaths: string[], outputFilename: string }`

* **Output:** Ruta del PDF unificado.

### 3.5. `apply_pdf_security`

* **Propósito:** Añade protección con contraseña, restricciones de impresión/copia y metadatos oficiales (Autor, Título, Palabras clave) a un PDF existente.

* **Input:** `{ filePath: string, userPassword?: string, ownerPassword?: string, permissions: { printing: boolean, copying: boolean } }`

## 4. Catálogo Completo de Componentes (React-like)

El motor debe soportar los siguientes componentes organizados por categoría:

### 4.1. Layout y Estructura

* `PageBreak`: Fuerza un salto de página inmediato.

* `View`: Contenedor Flexbox (`row`, `column`, `gap`, `padding`, `margin`, `backgroundColor`, `border`, `wrap: boolean`).

* `Grid`: Sistema de rejilla simplificado (`columns: number`, `gap: number`) para alinear tarjetas o métricas sin que el LLM luche con Flexbox.

* `Spacer`: Espacio en blanco vertical u horizontal (`size: number`).

* `Divider`: Línea separadora horizontal (`color`, `thickness`, `style: "solid" | "dashed"`).

### 4.2. Tipografía y Texto

* `DocumentHeader`: Cabecera corporativa (`title`, `subtitle`, `logoUrl`, `badgeText`, `alignment`).

* `SectionTitle`: Título de sección con soporte para numeración automática y borde inferior.

* `Text`: Párrafo con soporte para negritas/cursivas básicas (parseo ligero de Markdown inline como `**texto**` y código inline `` `SELECT` ``), alineación y colores del tema.

* `Callout`: Caja de alerta o resumen destacado (`type: "info" | "warning" | "success" | "danger"`, `title`, `content`).

### 4.3. Datos y Visualización (Alto Ahorro de Tokens)

* `DataTable`: Tabla inteligente con paginación automática (repite los encabezados `thead` si la tabla cruza de página), zebra-striping, alineación por columna (`left`, `center`, `right`) y formato de moneda/fecha.

* `KeyValueList`: Lista de pares clave-valor en 1 o 2 columnas (ideal para datos de clientes, metadatos de facturas o especificaciones técnicas).

* `MetricCard`: Tarjeta de KPI (`label`, `value`, `trend?: "+15%"`, `trendColor`).

* `Chart`: Renderiza gráficos vectoriales (`type: "bar" | "line" | "pie" | "doughnut"`, `labels: string[]`, `datasets: Array<{ label: string, data: number[] }>`).

### 4.4. Técnico y Desarrollo (Informes de Ingeniería y Datos)

* `CodeBlock`: Bloque especializado para código fuente y consultas de bases de datos.
  * **Props:**
    * `code` (string, requerido): El código o query a renderizar.
    * `language` (`"sql" | "python" | "json" | "javascript" | "typescript" | "bash" | "yaml" | "text"`, default: `"sql"`): Define el motor de resaltado de sintaxis.
    * `title` (string, opcional): Ej. `"query_extraccion_ventas.sql"` o `"Pipeline ETL"`. Se renderiza como una barra de encabezado superior estilo IDE/terminal.
    * `showLineNumbers` (boolean, default: `true`): Muestra una columna izquierda con el número de línea para facilitar referencias en el texto.
    * `lineNumberStyle` (`"vector" | "text"`, default: `"vector"`): `"vector"` dibuja los números como trazos vectoriales, de modo que al copiar el bloque desde el PDF solo se obtiene el código. `"text"` mantiene la numeración como texto seleccionable (comportamiento heredado).
    * `wrap` (`"fit" | "soft"`, default: `"fit"`): `"fit"` reduce la tipografía del bloque (hasta un piso de 5.8pt) antes de partir líneas, lo que evita cortes al pegar; `"soft"` conserva el tamaño base y ajusta el texto al ancho disponible. Las filas de continuación se marcan con una flecha vectorial y nunca añaden indentación artificial al texto copiado.
    * `highlightLines` (number[], opcional): Array de números de línea (ej. `[4, 5, 12]`) que recibirán un fondo resaltado suave para llamar la atención del lector sobre partes críticas de la query.
  * **Copia exacta:** como el ajuste visual de líneas no se puede representar en la capa de texto de un PDF, `settings.codeExport` permite exportar el fuente literal: `"none"` (default), `"sidecar"` (escribe `<documento>.code.md` junto al PDF), `"embedded"` (lo adjunta dentro del PDF, visible en el panel de adjuntos) o `"both"`. El resultado se devuelve en `codeExports`.
    * `theme` (`"light" | "dark"`, default: `"light"`): `"light"` (estilo GitHub/Clean Docs, ideal para impresión) o `"dark"` (estilo OneDark/Dracula, ideal para lectura en pantalla).

### 4.5. Medios y Especiales

* `Image`: Soporta URLs remotas (con timeout y fallback de error), rutas locales y Base64.

* `QRCode`: Genera y renderiza un código QR limpio a partir de un string (`value`, `size`, `caption`).

* `SignatureBlock`: Bloque formal para firmas al final de contratos (`signers: Array<{ name: string, role: string, date?: string }>`).

* `FixedHeader` / `FixedFooter`: Elementos que se repiten automáticamente en todas las páginas, con variables inyectadas como `{{pageNumber}}` y `{{totalPages}}`.

## 5. Esquema Maestro de `generate_pdf` y Sistema de Temas

Para evitar que el LLM envíe estilos repetitivos, el servidor implementará un **Sistema de Temas (Design Tokens)**.

```json
{
  "name": "generate_pdf",
  "description": "Genera un documento PDF de alta calidad usando componentes estructurados y temas predefinidos.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filename": { "type": "string" },
      "outputDir": { "type": "string", "description": "Opcional. Directorio de salida." },
      "settings": {
        "type": "object",
        "properties": {
          "pageSize": { "type": "string", "enum": ["A4", "LETTER", "LEGAL"], "default": "A4" },
          "orientation": { "type": "string", "enum": ["portrait", "landscape"], "default": "portrait" },
          "margins": {
            "type": "object",
            "properties": { "top": { "type": "number" }, "bottom": { "type": "number" }, "left": { "type": "number" }, "right": { "type": "number" } }
          }
        }
      },
      "theme": {
        "type": "object",
        "description": "Configuración visual global del documento.",
        "properties": {
          "preset": { "type": "string", "enum": ["corporate_blue", "modern_minimal", "executive_dark", "financial_classic", "technical_docs"], "default": "corporate_blue" },
          "primaryColor": { "type": "string", "description": "Hex color override (ej. #1E40AF)" },
          "fontFamily": { "type": "string", "enum": ["Helvetica", "Times-Roman", "Courier", "Inter", "Roboto"], "default": "Inter" }
        }
      },
      "metadata": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "author": { "type": "string" },
          "subject": { "type": "string" }
        }
      },
      "fixedHeader": { "type": "object", "description": "Componente opcional que se repite arriba en cada página." },
      "fixedFooter": { "type": "object", "description": "Componente opcional que se repite abajo (soporta paginación)." },
      "content": {
        "type": "array",
        "description": "Árbol secuencial de componentes del cuerpo del documento.",
        "items": { "$ref": "#/definitions/ComponentNode" }
      }
    },
    "required": ["filename", "content"]
  }
}
```

## 6. Reglas Críticas de Ingeniería para el Agente Desarrollador

El agente de IA que construya este servidor debe cumplir estrictamente con estas directrices técnicas para evitar fallos en tiempo de ejecución:

### 6.1. Gestión de Fuentes (`Font.register`) y Tipografía Monoespaciada

* `@react-pdf/renderer` solo soporta Helvetica, Courier y Times por defecto. Para soportar fuentes modernas (`Inter`, `Roboto`) y una fuente monoespaciada legible para el componente `CodeBlock` (`JetBrainsMono` o `FiraCode`), el proyecto debe incluir los archivos `.ttf` en `assets/fonts/` y registrarlos al iniciar usando `Font.register()`. **No depender de URLs externas** para garantizar funcionamiento offline y velocidad.

### 6.2. Ingeniería del `CodeBlock` (Resaltado, Wrapping y Paginación)

* **Sin DOM en Node:** No usar librerías de resaltado que requieran `window` o `document`. Usar `lowlight` (basado en highlight.js) para obtener un árbol HAST (Hypertext Abstract Syntax Tree) y mapear cada token (`hljs-keyword`, `hljs-string`, `hljs-number`, `hljs-comment`) a un componente `<Text style={{ color: tokenColor }}>` de `@react-pdf`.
* **Prevención de Desbordamiento Horizontal:** En PDF no existe el *scroll* horizontal. El contenedor de código debe aplicar ajuste de línea inteligente (*soft-wrap*) preservando la indentación visual para que líneas SQL muy largas (como expresiones regulares o listas extensas en cláusulas `IN (...)`) no se corten fuera del margen derecho de la página.
* **Paginación de Scripts Largos:** A diferencia de `MetricCard`, un `CodeBlock` largo (ej. 80 líneas de SQL) **SÍ debe permitir** `wrap={true}` entre líneas, pero cada línea individual (`<View style={{ flexDirection: 'row' }} wrap={false}>`) debe evitar partirse por la mitad verticalmente.

### 6.3. Prevención de Crashes por Imágenes

* Si el LLM pasa una URL de imagen caída (404) o un formato no soportado (como WebP, ya que `@react-pdf` solo soporta PNG y JPG), el renderizado completo fallará.
* **Solución Obligatoria:** Crear un *Image Pre-processor* antes del renderizado que descargue las imágenes con un timeout de 5 segundos, verifique su MIME-type, convierta WebP/SVG a PNG si es necesario (usando `sharp`), y si falla, inyecte una imagen *placeholder* transparente o un bloque de texto `[Imagen no disponible]` en lugar de romper el proceso.

### 6.4. Control de Saltos de Página (`wrap={false}`)

* Componentes críticos como `MetricCard`, `SignatureBlock`, `Callout` y las filas individuales de `DataTable` deben tener la propiedad `wrap={false}` en su `<View>` contenedor de `@react-pdf`. Esto evita que una tarjeta o firma quede partida por la mitad entre el final de una página y el inicio de la siguiente.

### 6.5. Parseo de Texto Enriquecido (Inline Markdown)

* Los LLMs tienden a escribir `**negrita**` y `` `código inline` `` dentro de los textos explicativos. El componente `Text` del servidor debe incluir un parser ligero que procese `**texto**` (negrita) y `` `código` `` (renderizado con fuente monoespaciada y fondo gris suave), manteniendo la coherencia visual entre tus párrafos de análisis y tus bloques `CodeBlock`.

### 6.6. Manejo de Errores Descriptivos (Self-Healing para el LLM)

* Si la validación de `zod` o el motor de `@react-pdf` lanza una excepción, el servidor MCP debe capturarla y devolver `isError: true` con un mensaje estructurado explicando **exactamente qué componente falló y qué propiedad es inválida**, permitiendo que el LLM se autocorrija en el siguiente turno sin intervención humana.

## 7. Estructura de Directorios Recomendada

```text
mcp-pdf-server/
├── package.json
├── tsconfig.json
├── assets/
│   └── fonts/               # Archivos .ttf (Inter, Roboto, JetBrainsMono-Regular.ttf)
├── src/
│   ├── index.ts             # Punto de entrada del servidor MCP (Stdio/SSE)
│   ├── tools/               # Definición y handlers de las 5 herramientas MCP
│   │   ├── generatePdf.ts
│   │   ├── validateAst.ts
│   │   ├── listComponents.ts
│   │   ├── mergePdfs.ts
│   │   └── securityPdf.ts
│   ├── schemas/             # Esquemas Zod estrictos para validación del AST
│   │   └── astSchema.ts
│   ├── engine/              # Motor de compilación AST -> React Elements
│   │   ├── pdfRenderer.tsx
│   │   ├── themeProvider.ts
│   │   ├── codeHighlighter.ts # Tokenizador lowlight -> React-PDF Text
│   │   └── imageProcessor.ts
│   └── components/          # Implementación de componentes en @react-pdf/renderer
│       ├── layout/
│       ├── typography/
│       ├── data/
│       ├── technical/       # CodeBlock.tsx
│       └── media/
└── tests/                   # Pruebas unitarias con ASTs de ejemplo (Informes SQL, Facturas)
```