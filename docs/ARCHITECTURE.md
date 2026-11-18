# Arquitectura y decisiones de ingeniería

## Vista general

El servidor separa el contrato MCP, la validación del AST, la compilación visual y el acceso al sistema de archivos. El modelo solo puede describir documentos mediante nodos JSON tipados: no se acepta JSX, HTML, CSS arbitrario, JavaScript, plantillas ejecutables ni nombres de componentes dinámicos.

```text
Cliente MCP / agente
        | JSON-RPC (stdio o Streamable HTTP)
        v
Registro de herramientas MCP
        |
        +--> list_pdf_components --> catálogo + JSON Schema
        +--> validate_pdf_ast -----> Zod + reglas semánticas
        +--> generate_pdf ---------> validación --> activos/QR --> AST React-PDF --> PDF
        +--> merge_pdfs ----------> pdf-lib --> PDF final
        +--> apply_pdf_security --> pdf-lib metadatos --> qpdf AES-256 (opcional)

Salida: PDF en PDF_MCP_OUTPUT_DIR
Activos: PDF_MCP_ASSET_DIR (solo lectura recomendado)
Fuentes: PDF_MCP_FONT_DIR (locales y opcionales)
```

## Límites de confianza

1. **LLM no confiable:** el AST se valida con Zod en modo estricto y reglas semánticas adicionales. Los nodos desconocidos y propiedades adicionales se rechazan. No hay `eval`.
2. **Archivos:** los PDFs de entrada/salida quedan confinados al directorio de salida configurado. Se resuelven enlaces simbólicos antes de operar; los archivos escritos usan temporales y renombrado/enlace atómico.
3. **Imágenes remotas:** desactivadas por defecto. Al habilitarlas solo se permite HTTPS, se comprueban todas las IP resueltas contra rangos privados/reservados y se fija la IP para evitar DNS rebinding. Se revalidan redirecciones, MIME, tamaño y tiempo.
4. **Imágenes SVG:** se rechazan scripts, eventos, DTD/entidades, referencias externas, imports y fuentes remotas antes de rasterizar.
5. **HTTP:** escucha en loopback por defecto. Para binding remoto exige bearer token; aplica allowlists de Host/Origin, máximo de 100 sesiones, cuerpo máximo de 16 MiB y límites de concurrencia de render. CORS preflight y health check no requieren bearer.
6. **Procesos externos:** qpdf se invoca con `spawn` y un arreglo de argumentos, nunca mediante shell. Como qpdf recibe passwords por argumentos, el servicio debe correr con una cuenta de sistema dedicada y acceso de proceso restringido.
7. **Contención:** Docker corre como usuario no privilegiado, FS de solo lectura, `no-new-privileges`, capacidades eliminadas, tmpfs acotado y límites CPU/memoria/PIDs.

## Pipeline de generación

1. Se limita el tamaño JSON y la profundidad del árbol.
2. Zod 4 aplica tipos, enumeraciones, valores por defecto, límites de campos y `strict()`. El esquema JSON Schema se deriva del mismo contrato para evitar divergencias de documentación.
3. Reglas semánticas comprueban longitudes de series, claves de tabla duplicadas, líneas de código y referencias de imágenes.
4. Las imágenes se normalizan a PNG; un fallo aislado produce placeholder y warning en vez de abortar todo el documento.
5. Los QR se preparan en lotes; un valor que no se pueda codificar produce placeholder y warning.
6. El AST se transforma a componentes `@react-pdf/renderer`; ningún valor del AST se interpreta como código.
7. El PDF se analiza para obtener número de páginas, se valida que no esté vacío y se escribe atómicamente con límites de bytes.

## Componentes de dominio

Layout: `PageBreak`, `View`, `Grid`, `Spacer`, `Divider`.

Tipografía: `DocumentHeader`, `SectionTitle`, `Text`, `Callout`, `BulletList`.

Datos: `DataTable`, `KeyValueList`, `MetricCard`, `Chart`, `InvoiceSummary`, `SignatureBlock`.

Visualización: `Flowchart`, con auto-layout por capas (camino más largo sobre el grafo acíclico), formas por tipo de nodo y aristas ortogonales etiquetadas. El cálculo vive en `src/engine/flowchartLayout.ts`, fuera de React-PDF, para poder probarlo sin renderizar.

Técnico: `CodeBlock`, con lowlight sin DOM, resaltado por token y soft-wrap.

Media: `Image`, `QRCode`.

Cabeceras y pies fijos se describen en `fixedHeader` y `fixedFooter` al nivel del documento.

## Límites deliberados

- `DataTable` repite su encabezado solo en tablas de referencia (más de 12 filas); las tablas cortas se mantienen indivisibles para no dejar un encabezado huérfano al pie de página.
- Los gráficos bar/line muestran hasta seis series. Pie/doughnut usa el primer dataset como distribución.
- `SignatureBlock` es una representación visual, no una firma digital X.509/PAdES.
- `apply_pdf_security` restringe permisos de lectores compatibles, pero no constituye DRM.
- `pdf-lib` no descifra PDFs de entrada protegidos; deben abrirse/descifrarse previamente.
- El MCP no llama a ningún LLM: el agente/cliente construye el AST, ejecuta la validación y decide cómo usar el PDF.
