# Guía de generación PDF para agentes de IA

Esta guía define un flujo eficiente y repetible para agentes que consumen `mcp-pdf-server` mediante Model Context Protocol.

## Objetivo

El modelo debe producir un documento correcto a partir de datos y requisitos, no diseñar código de presentación. El servidor controla tipografía, espaciado, tablas, gráficos, paginación y seguridad. El agente solo selecciona componentes del catálogo y suministra contenido estructurado.

## Flujo obligatorio

1. **Inspeccionar el entorno una vez por sesión (`get_pdf_server_info`):** devuelve el `workspace.primaryRoot` detectado (por MCP `roots` o `cwd`), la carpeta de salida por defecto (`output.directory`), las raíces permitidas (`output.allowedRoots`), las fuentes instaladas (`Inter`, `JetBrainsMono`, etc.) y si `qpdf` está disponible para cifrado.
2. **Descubrir componentes por categoría (`list_pdf_components`):** llamar con la categoría relevante (`layout`, `typography`, `data`, `technical`, `media` o `all`).
3. **Planificar antes de serializar:** identificar secciones, tablas, métricas, visualizaciones, anexos y saltos de página. No repetir estilos disponibles en el tema.
4. **Construir el AST:** emitir solo propiedades documentadas. Usar componentes compuestos (`DataTable`, `MetricCard`, `InvoiceSummary`, `Chart`, `Flowchart`, `CodeBlock`) en vez de simularlos con muchos `View` y `Text`.
5. **Validar (`validate_pdf_ast`):** pasar el documento completo. Resolver todos los errores y revisar advertencias.
6. **Generar (`generate_pdf`):** elegir `outputDir` según dónde lo necesite el usuario:
   - Omitir `outputDir` para guardar en `<proyecto>/output`.
   - `outputDir: "."` para guardar en la raíz del proyecto activo.
   - `outputDir: "reports/2026"` (o cualquier ruta relativa) para guardar en una subcarpeta del proyecto.
   - Una ruta absoluta dentro del workspace o de `PDF_MCP_ALLOWED_DIRS`.
   La respuesta incluye `path` (absoluto), `relativePath` (relativo al proyecto), `pages`, `outline` de secciones y `warnings`.
7. **Verificar y autocorregir maquetación (`inspect_pdf`):** llamar a `inspect_pdf` sobre el archivo generado para comprobar orientación por página, densidad de caracteres y alertas como `SPARSE_TRAILING_PAGE` (última página casi vacía con líneas huérfanas). Si aparece `SPARSE_TRAILING_PAGE` o `EMPTY_PAGE`, compactar tablas (`compact: true`), consolidar prosa en `Markdown` o eliminar `PageBreak` sobrantes y regenerar.
8. **Localizar, componer y proteger (`list_pdfs`, `merge_pdfs`, `apply_pdf_security`):** usar `list_pdfs` para descubrir PDFs existentes en el proyecto sin adivinar rutas, y luego `merge_pdfs` o `apply_pdf_security` cuando sea necesario. Nunca incluir contraseñas en el contenido del documento.

## Reglas de eficiencia de tokens

- **Usar `Markdown` para secciones de prosa extensa (ahorro de 50–70% de tokens):** un nodo `{ "type": "Markdown", "markdown": "## Análisis\n\n..." }` compila de forma determinista encabezados `#`, párrafos con `**negrita**`/`*cursiva*`/`[links](https://...)`, alertas `> [!WARNING]` / `> [!NOTE]`, citas `>`, listas anidadas y checklists `- [x]`, tablas GFM y bloques de código cercados en nodos AST nativos, sin ejecutar HTML/CSS.
- **Filtrar `list_pdf_components` por categoría:** pedir solo la categoría necesaria (`layout`, `typography`, `data`, `technical`, `media`) omite el JSON Schema completo salvo que se indique `includeSchema: true`.
- **Aprovechar MCP Resources y Prompts:** consultar `pdf://guide/workflow`, `pdf://examples/monthly-sales-report`, `pdf://examples/invoice` y los prompts `executive-report`, `technical-spec`, `commercial-proposal` e `invoice`.

- Reutilizar un único tema global (`corporate_blue`, `modern_minimal`, `executive_dark`, `financial_classic` o `technical_docs`). No enviar colores por cada nodo salvo que exista una excepción justificada.
- La fuente predeterminada es `Inter` (con variantes Regular 400, Italic, SemiBold 600, Bold 700 y BoldItalic 700) y `JetBrainsMono` (sin ligaduras, para copia literal) en código. Para un contraste editorial clásico, puedes combinar `theme.headingFontFamily` (p. ej. `"Times-Roman"` en títulos y `"Inter"` en cuerpo).
- Preferir `DataTable` para conjuntos de registros; no crear una fila manual de `View` por cada celda.
- Preferir `Grid` + `MetricCard` para KPIs; no construir tarjetas manualmente con decenas de propiedades.
- Usar `KeyValueList` para metadatos y `InvoiceSummary` para importes.
- Usar `Chart` para series numéricas y no dibujar barras con primitivas `View`.
- Usar `Flowchart` para procesos, estados o topologías con relaciones; no simularlas con `Grid` y `View`.
- Usar `CodeBlock` para SQL, código y configuración; evitar enviar Markdown de código dentro de `Text`.
- Cuando el lector vaya a copiar el código desde el PDF (por ejemplo, para pegarlo en un IDE), añadir `settings.codeExport: "sidecar"` o `"both"`: el fuente exacto se escribe como `<documento>.code.md` junto al PDF y/o queda adjunto dentro de él. La numeración de línea ya no se copia, pero el ajuste de líneas largas sí puede partir filas.
- No incluir defaults explícitos. El esquema aplica `A4`, márgenes, paleta y tipografías predeterminados.
- No duplicar la información en subtítulos, callouts y tablas. Cada dato debe aparecer donde aporte valor.
- Mantener `filename` estable, descriptivo y sin extensión obligatoria. El servidor añade `.pdf`.
- Las imágenes deben ser necesarias. Preferir assets relativos de confianza; las descargas HTTPS están deshabilitadas de forma predeterminada.

## Selección de componentes

| Necesidad | Componente recomendado |
|---|---|
| Portada ejecutiva a página completa | `CoverPage` |
| Índice navegable automático + marcadores PDF | `TableOfContents` + `SectionTitle` |
| Cabecera editorial en primera página | `DocumentHeader` |
| Prosa extensa, alertas, listas y tablas rápidas | `Markdown` |
| Párrafos individuales y avisos puntuales | `Text`, `Callout`, `Quote`, `Badge` |
| Indicadores principales y tendencias | `Grid` (`weights` opcional) + `MetricCard` (`sparkline` opcional) |
| Datos tabulares con estados y fila de totales | `DataTable` (`format: "badge" \| "boolean" \| "currency"`, `footerRow`) |
| Hitos cronológicos o plan de trabajo | `Timeline` |
| Listas jerárquicas o checklists | `BulletList` (`variant: "check"`, `children`) |
| Comparación de series y participaciones | `Chart` (`bar`, `horizontalBar`, `line`, `pie`, `doughnut`) |
| Procesos, estados o topologías | `Flowchart` |
| Código resaltado (24 lenguajes) | `CodeBlock` |
| Totales de factura y firmas formales | `InvoiceSummary`, `SignatureBlock` |
| Anexos apaisados en el mismo documento | `Section` (`orientation: "landscape"`) |

## Plantilla compacta de informe

```json
{
  "filename": "informe-ejecutivo-2026-11",
  "theme": { "preset": "corporate_blue" },
  "metadata": { "title": "Informe ejecutivo", "author": "Área responsable" },
  "fixedFooter": { "showPageNumbers": true },
  "content": [
    { "type": "DocumentHeader", "title": "Informe ejecutivo", "subtitle": "Noviembre 2026" },
    { "type": "Grid", "columns": 3, "children": [
      { "type": "MetricCard", "label": "Ventas", "value": "S/ 125,400", "trend": "+8.4%" },
      { "type": "MetricCard", "label": "Unidades", "value": 2450 },
      { "type": "MetricCard", "label": "Ticket promedio", "value": "S/ 51.18" }
    ] },
    { "type": "SectionTitle", "title": "Resumen", "autoNumber": true },
    { "type": "Text", "text": "Las ventas crecieron **8.4%** respecto al período anterior." },
    { "type": "Callout", "variant": "info", "title": "Hallazgo", "content": "La categoría principal concentró el mayor crecimiento." },
    { "type": "SectionTitle", "title": "Evolución mensual", "autoNumber": true },
    { "type": "Chart", "chartType": "line", "labels": ["Ago", "Sep", "Oct", "Nov"], "datasets": [{ "label": "Ventas", "data": [98000, 104000, 115000, 125400] }] }
  ]
}
```

### Diagramas de flujo

Un `Flowchart` declara nodos y aristas; el servidor calcula las capas, el tamaño de las cajas y el recorrido de las flechas. No se envían coordenadas.

```json
{
  "type": "Flowchart",
  "title": "Aprobación de una solicitud",
  "direction": "vertical",
  "nodes": [
    { "id": "inicio", "kind": "start", "label": "Solicitud recibida" },
    { "id": "revision", "kind": "process", "label": "Revisión documental", "description": "Validación de datos y anexos" },
    { "id": "decision", "kind": "decision", "label": "¿Cumple requisitos?" },
    { "id": "aprobado", "kind": "end", "label": "Aprobado" },
    { "id": "observado", "kind": "document", "label": "Observado" }
  ],
  "edges": [
    { "from": "inicio", "to": "revision" },
    { "from": "revision", "to": "decision" },
    { "from": "decision", "to": "aprobado", "label": "sí" },
    { "from": "decision", "to": "observado", "label": "no", "style": "dashed" }
  ],
  "caption": "Flujo de aprobación con las dos salidas del control."
}
```

Reglas prácticas: ids cortos y únicos, `kind` según el rol (`start`, `process`, `decision`, `data`, `document`, `database`, `end`), una idea por nodo y máximo ~20 nodos. Los ciclos se permiten y se dibujan como aristas de retorno laterales; el validador los informa como advertencia. El diagrama se mantiene indivisible: si no cabe en el espacio restante, pasa a la página siguiente.

## Reglas de calidad editorial

- Usar títulos informativos: “Evolución de ventas por sucursal” es mejor que “Análisis”.
- Incluir período, moneda, unidad de medida y fuente de datos cuando puedan confundirse.
- Mantener consistencia en decimales y moneda; especificar `currency` y `locale` en tablas y resúmenes.
- Evitar tablas con demasiadas columnas. Dividir una tabla muy ancha por tema, no reducir la fuente hasta hacerla ilegible.
- Para tablas largas, agregar `caption` descriptivo y ordenar previamente los datos.
- No representar como hecho una inferencia del modelo. Etiquetar estimaciones, supuestos y datos faltantes.
- No inventar firmas, aprobaciones, identidades, importes, fechas ni metadatos oficiales.
- Revisar que subtotales, impuestos, descuentos y totales sean coherentes antes de enviarlos al renderizador.
- El bloque `SignatureBlock` es visual; no equivale a una firma electrónica o digital certificada.

## Autocorrección

Cuando `validate_pdf_ast` devuelva errores:

1. Leer `path`, `message` y `code` de cada error.
2. Corregir únicamente los nodos o propiedades identificados.
3. Revalidar el AST completo.
4. No intentar eludir errores eliminando validaciones ni agregando propiedades no documentadas.

Cuando `generate_pdf` devuelva advertencias, tratarlas como hallazgos: una imagen ausente puede dejar un placeholder; un dato faltante puede mostrarse como `-`; una imagen remota puede estar deshabilitada por política. Informar al usuario de las advertencias relevantes.

## Límites importantes

- Las imágenes remotas requieren `PDF_MCP_ALLOW_REMOTE_IMAGES=true` y solo HTTPS; las IP privadas/reservadas deben seguir bloqueadas.
- Los archivos pueden guardarse en cualquier carpeta del proyecto activo (detectado por MCP `roots` o `cwd`) y en las carpetas adicionales declaradas en `PDF_MCP_ALLOWED_DIRS` (o en cualquier ruta si se habilita `PDF_MCP_ALLOW_ANY_PATH=true`); las imágenes locales se leen desde `PDF_MCP_ASSET_DIR`.
- `apply_pdf_security` requiere `qpdf` para cifrado y restricciones (auto-detectado en Windows, macOS y Linux). Las restricciones de impresión/copia no sustituyen controles criptográficos de distribución.
- `SignatureBlock` no crea firmas criptográficas PAdES.
- El servidor no consulta bases de datos ni llama a un LLM: el agente debe obtener/verificar los datos con sus fuentes antes de crear el AST.
