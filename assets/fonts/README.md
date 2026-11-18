# Fuentes tipográficas

El servidor funciona sin archivos de fuentes, usando Helvetica/Courier/Times-Roman integradas en PDF. Además, este workspace incluye dos familias libres para lograr una salida más cuidada:

- **Inter** — texto corrido y títulos (`Inter-Regular.ttf`, `Inter-Italic.ttf`, `Inter-SemiBold.ttf`, `Inter-Bold.ttf`, `Inter-BoldItalic.ttf`). Licencia SIL OFL en `Inter-LICENSE.txt`.
- **JetBrains Mono** — bloques de código y `código inline` (`JetBrainsMono-Regular.ttf`, `JetBrainsMono-Italic.ttf`, `JetBrainsMono-Bold.ttf`). Licencia SIL OFL en `JetBrainsMono-OFL.txt`.

Se pueden añadir más familias (`Roboto-*.ttf`) en este directorio o en la ruta indicada por `PDF_MCP_FONT_DIR`.

Todas las caras son opcionales: se registra la familia si existe al menos `*-Regular.ttf`, y cada variante (cursiva, semibold, negrita) se activa solo si su archivo está presente. Si falta una cara no se inventa un estilo sintético: se usa la más cercana de la propia familia.

Si la familia solicitada en `theme.fontFamily` no está instalada, se usa Helvetica y la respuesta de `generate_pdf` incluye un warning indicando el reemplazo. Los bloques de código caen a Courier solo si JetBrains Mono no está disponible.

Sobre licencias: Inter y JetBrains Mono se publican bajo SIL Open Font License; los textos completos están junto a los archivos. Si redistribuyes este workspace, conserva ambos archivos de licencia.
