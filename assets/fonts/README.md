# Fuentes tipográficas

El servidor funciona sin archivos externos gracias a las fuentes base de PDF (`Helvetica`, `Courier`, `Times-Roman`), pero **incluye por defecto** dos familias libres bajo SIL Open Font License en `assets/fonts`:

- **Inter** — fuente predeterminada (`theme.fontFamily: "Inter"`) para cuerpo, subtítulos, tablas y encabezados (`Inter-Regular.ttf`, `Inter-Italic.ttf`, `Inter-SemiBold.ttf`, `Inter-Bold.ttf`, `Inter-BoldItalic.ttf`). Licencia en `Inter-LICENSE.txt`.
- **JetBrains Mono** — fuente monoespaciada predeterminada para `CodeBlock` y `` `código inline` `` (`JetBrainsMono-Regular.ttf`, `JetBrainsMono-Italic.ttf`, `JetBrainsMono-Bold.ttf`). El motor desactiva las ligaduras OpenType (`calt`, `liga`, `clig`, `dlig`, `rlig`) en cada bloque de código para que operadores como `<=`, `<>`, `>=`, `!=` y `=>` se copien siempre como caracteres ASCII literales. Licencia en `JetBrainsMono-OFL.txt`.

## Combinación de fuentes (`headingFontFamily`) y pesos

- `theme.fontFamily` define la fuente de lectura (`Inter` por defecto).
- `theme.headingFontFamily` permite asignar una familia distinta a títulos, encabezados de tabla y KPIs (por ejemplo, `Times-Roman` en títulos con `Inter` en cuerpo, o viceversa).
- El componente `Text` admite `weight: "normal" | "semibold" | "bold"` (400, 600 y 700), aprovechando `Inter-SemiBold.ttf` para jerarquías intermedias.

## Añadir más familias

Puedes colocar `Roboto-Regular.ttf`, `Roboto-Italic.ttf`, `Roboto-Medium.ttf` y `Roboto-Bold.ttf` en este directorio o en la ruta indicada por `PDF_MCP_FONT_DIR`.

Todas las caras son opcionales: una familia se activa si existe su archivo `*-Regular.ttf`. Si la familia solicitada no está instalada, se aplica `Helvetica` (o `Courier` en código) y `generate_pdf` devuelve un `warning` explicando el reemplazo. Puedes consultar las fuentes detectadas en tiempo de ejecución con la herramienta `get_pdf_server_info`.
