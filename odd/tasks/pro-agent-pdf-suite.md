Objective: Upgrade mcp-pdf-server security, engine performance, layout/typography precision, professional AST components, and MCP AI-agent ergonomics.
Branch: feat/pdf-pro-1-security .. feat/pdf-pro-6-mcp-ergonomics (base: main @ 9df1fce) | Delivery strategy: ask-on-risk (chain_strategy: stacked-to-main; slices: PR1=T1, PR2=T2, PR3=T3, PR4=T4, PR5=T5, PR6=T6; forecast: ~1,950 lines)
Test runner: npm test && npm run typecheck | Mirror: pending (Engram MCP unavailable in session)

## Specs

- **S1 — Security & Operational Hardening (High-Risk Item 2: security)**
  - User request verbatim: `"Revisa el proyecto actual en busqueda de mejoras y optimizaciones, nuevos componentes o mejoras en los existentes, con el objetivo de que un agente de ia lo pueda usar para generar de manera optima resultados profesionales."` -> `"apliacalas"`
  - Scope: `src/engine/imageProcessor.ts`, `src/utils/qpdf.ts`, `src/tools/securityPdf.ts`, `src/transports/http.ts`, `tests/security.test.ts`.
  - Acceptance criteria:
    1. Replace string-prefix IPv6 checks in `blockedIp` with canonical `net.BlockList` rules blocking all private, loopback, link-local (`fe80::/10`), site-local (`fec0::/10`), ULA (`fc00::/7`), multicast (`ff00::/8`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`), Teredo (`2001::/32`, including compressed `2001::...`), discard (`100::/64`), documentation (`2001:db8::/32`), benchmarking (`2001:2::/48`), and IPv4-mapped/compatible IPv6 addresses, while allowing public IPv4/IPv6 unicast addresses.
    2. Deliver `qpdf` encryption flags and passwords via `@-` stdin argument lines instead of CLI process arguments so secrets are not exposed in process tables (`ps` / `/proc/<pid>/cmdline`), rejecting newline injection cleanly.
    3. Track `lastActiveAt` on HTTP MCP sessions in `src/transports/http.ts` and evict idle sessions exceeding configurable TTL (default 30 minutes) periodically and before `MAX_SESSIONS` rejection.
  - Applicable checks: `npx tsx --test tests/security.test.ts`, `npm test`, `npm run typecheck`, plus Independent Verifier (High-Risk Item 2).

- **S2 — Engine Performance, Caching & Validation Parity**
  - User request verbatim: `"apliacalas"`
  - Scope: `src/engine/imageProcessor.ts`, `src/engine/validate.ts`, `src/tools/register.ts`, `src/tools/generatePdf.ts`, `src/engine/render.tsx`, `tests/engine-perf.test.ts`.
  - Acceptance criteria:
    1. Detect SVG payloads in `processImageSource` by inspecting at most the first 4 KB (after BOM/whitespace) rather than decoding multi-megabyte raster buffers to UTF-8; keep JPEG inputs encoded as sanitized JPEG buffers (`sharp.jpeg`) instead of inflating them into level-9 PNGs; cache processed image buffers in a bounded SHA-256 LRU map.
    2. Memoize `getComponentSchema()` once; omit full JSON Schema from `list_pdf_components` when filtering by a specific category unless `includeSchema: true` or `category === 'all'`; enforce unique image (`<=40`) and QR (`<=100`) limits, `InvoiceSummary` arithmetic mismatch warning, and missing local asset warning in `validatePdfAst`.
    3. Eliminate redundant triple AST validation on `generate_pdf` and avoid double `PDFDocument.load` when `settings.codeExport` embeds source attachments.
  - Applicable checks: `npx tsx --test tests/engine-perf.test.ts`, `npm test`, `npm run typecheck`.

- **S3 — Layout, Pagination, Locale, Inline Markup, CodeBlock & Chart Fixes**
  - User request verbatim: `"apliacalas"`
  - Scope: `src/schemas/ast.ts`, `src/engine/render.tsx`, `src/engine/inlineMarkup.ts`, `src/engine/codeHighlighter.tsx`, `tests/layout-fixes.test.ts`.
  - Assumptions (marked): Default `settings.locale` remains `'es-PE'` so existing Spanish callers and tests stay backwards-compatible unless `settings.locale` overrides it (e.g., `'en-US'`).
  - Acceptance criteria:
    1. Narrow `context.contentWidth` accurately inside `View` (minus horizontal padding/border) and `Grid` (supporting optional column `weights: number[]` and subtracting column gaps).
    2. Apply explicit `paddingLeft` and `paddingRight` on `<Page>`, add `skipFirstPage?: boolean` on `fixedHeader`/`fixedFooter`, and localize built-in chrome (`Página X de Y` vs `Page X of Y`, `InvoiceSummary` labels, fallback placeholders) from `settings.locale`.
    3. Parse ISO `YYYY-MM-DD` strings in `DataTable` `formatCell` without UTC negative-offset day shifts; add height-aware `wrap` fallback for tall `Callout` and `BulletList` items; make `SectionTitle` `autoNumber` hierarchical (`1`, `1.1`, `1.1.1`).
    4. Support `*italic*` and `[label](https://...)` links in `inlineMarkup.ts` and render inline markup inside `DataTable` text cells, `KeyValueList` values, `DocumentHeader.subtitle`, and `InvoiceSummary.notes`.
    5. Tokenize `CodeBlock` once across the full block in `codeHighlighter.tsx` (propagating bold/italic across nested spans and unlocking common `lowlight` languages: Go, Rust, Java, C#, C++, HTML, CSS, XML, Dockerfile, GraphQL, Markdown, PHP); add `horizontalBar`, pie/doughnut percentage shares, and smart X-axis label truncation/stepping in `Chart`.
  - Applicable checks: `npx tsx --test tests/layout-fixes.test.ts`, `npm test`, `npm run typecheck`.

- **S4 — Professional AST Components (Part 1: Badges, Timelines, Quotes, Lists, Table Totals & Sparklines)**
  - User request verbatim: `"apliacalas"`
  - Scope: `src/schemas/ast.ts`, `src/engine/render.tsx`, `src/engine/validate.ts`, `tests/components-pro.test.ts`.
  - Acceptance criteria:
    1. Add `Badge` component (`text`, `tone`: `'neutral' | 'info' | 'success' | 'warning' | 'danger'`) and `'badge'` / `'boolean'` formatters + optional `footerRow` summary row in `DataTable`.
    2. Add `Timeline` component (`items` with `date`, `title`, `description`, `status`: `'done' | 'active' | 'pending'`) and `Quote` component (`text`, `author`, `role`).
    3. Support nested `BulletList` items (`children`) plus `'check'` style (`checked?: boolean`), and optional `sparkline: number[]` inside `MetricCard` using solid `#RRGGBB` SVG primitives.
  - Applicable checks: `npx tsx --test tests/components-pro.test.ts`, `npm test`, `npm run typecheck`.

- **S5 — Document-Structure & Authoring Components (Part 2: CoverPage, TOC, Bookmarks, Watermark, Multi-Orientation Sections & Markdown)**
  - User request verbatim: `"apliacalas"`
  - Scope: `src/schemas/ast.ts`, `src/engine/markdownParser.ts`, `src/engine/render.tsx`, `src/engine/validate.ts`, `tests/document-structure.test.ts`.
  - Acceptance criteria:
    1. Add `CoverPage` (eyebrow, title, subtitle, metadata items, brand accent, automatic page break & page-1 header/footer suppression), `TableOfContents` (auto-indexed from `SectionTitle` nodes with linked destinations), PDF `bookmark` outlines on `SectionTitle`, `settings.watermark` (`text`, `opacity`), and `Section` multi-page orientation overrides (`portrait` / `landscape` appendices).
    2. Add deterministic `Markdown` AST component (`markdown: string`) compiling headings, paragraphs, emphasis/code/links, blockquotes, lists, tables, and fenced code blocks into native AST nodes with zero HTML/CSS execution.
  - Applicable checks: `npx tsx --test tests/document-structure.test.ts`, `npm test`, `npm run typecheck`.

- **S6 — MCP Agent Ergonomics, Layout Telemetry, `inspect_pdf`, Resources, Prompts & Documentation**
  - User request verbatim: `"apliacalas"`
  - Scope: `src/schemas/ast.ts`, `src/components/catalog.ts`, `src/tools/inspectPdf.ts`, `src/tools/generatePdf.ts`, `src/tools/register.ts`, `src/resources/register.ts`, `src/server.ts`, `README.md`, `docs/LLM-AGENT-GUIDE.md`, `tests/mcp-ergonomics.test.ts`.
  - Acceptance criteria:
    1. Add MCP tool `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on all registered tools, `.describe(...)` metadata on AST schema properties, and full synchronization of `src/components/catalog.ts`.
    2. Register MCP `Resources` (`pdf://guide/workflow`, `pdf://examples/monthly-sales-report`, `pdf://examples/invoice`) and MCP `Prompts` (`executive-report`, `technical-spec`, `commercial-proposal`, `invoice`) in `src/server.ts`.
    3. Return layout telemetry from `generate_pdf` (`outline`, sparse-trailing-page warning) and expose read-only `inspect_pdf` tool (`pdfjs-dist` per-page dimensions, character counts, fill heuristics, extracted text preview) for agent self-correction; update `README.md` and `docs/LLM-AGENT-GUIDE.md`.
  - Applicable checks: `npx tsx --test tests/mcp-ergonomics.test.ts`, `npm test`, `npm run typecheck`, `npm run build`, `npm run smoke`.

## Tasks

- [x] **T1** (`S1`) | Route: `inline` (single security unit ~240 lines; Risk: item 2 security) | Evidence: `RED -> GREEN (43/43 npm test, typecheck, smoke:http 5/5) + Independent Verifier PASS` | Commit: `46e65ed` (`feat/pdf-pro-1-security`)
- [x] **T2** (`S2`) | Route: `inline` (shares `src/engine/imageProcessor.ts` with T1; ~320 lines; Risk: none) | Evidence: `RED -> GREEN (47/47 npm test, typecheck)` | Commit: `committing on feat/pdf-pro-2-engine-perf`
- [ ] **T3** (`S3`) | Route: `inline` (foundational `src/schemas/ast.ts` + `src/engine/render.tsx` fixes required by T4–T6; ~380 lines) | Commit: `pending`
- [ ] **T4** (`S4`) | Route: `inline` (extends `src/schemas/ast.ts` + `src/engine/render.tsx` on top of T3; ~360 lines) | Commit: `pending`
- [ ] **T5** (`S5`) | Route: `inline` (extends `src/schemas/ast.ts` + `src/engine/render.tsx` on top of T4; ~390 lines) | Commit: `pending`
- [ ] **T6** (`S6`) | Route: `inline` (wires full AST catalog, MCP annotations/resources/prompts, `inspect_pdf`, and docs on top of T5; ~380 lines) | Commit: `pending`

## Log

- **L1 (2026-11-24)**: `"Revisa el proyecto actual en busqueda de mejoras y optimizaciones, nuevos componentes o mejoras en los existentes, con el objetivo de que un agente de ia lo pueda usar para generar de manera optima resultados profesionales."`
- **L2 (2026-11-24)**: `"se colgo en algun proceso? o esta avanzando?"` — Delivered 4-pillar technical audit with `path:line` evidence (`odd_readonly_explorer` + parent spot check on `src/engine/imageProcessor.ts`).
- **L3 (2026-11-24)**: `"apliacalas"` — Explicit authorization to implement all 4 pillars. Baseline `npm test` (39/39 pass) and `npm run typecheck` verified green; pre-existing uncommitted changes in `src/engine/design.ts` and `tests/ast.test.ts` preserved.
- **L4 (2026-11-24)**: Completed **T1 (`S1`)**: separated `NON_PUBLIC_IPV4` and `NON_PUBLIC_IPV6` `net.BlockList` sets (including `::ffff:0:0/96` and `::ffff:0:0:0/96` SIIT), normalized FQDN hostnames, moved `qpdf` arguments to `@-` stdin with `--user-password=`/`--owner-password=` (`qpdf >= 11.7`), and added `SessionRegistry` idle TTL (`PDF_MCP_SESSION_TTL_MS`) + atomic slot reservation in `src/transports/http.ts`. Verified `43/43` tests, `typecheck`, `smoke:http` (`5/5`), and Independent Verifier recheck `PASS`. Pausing before first commit to request chain strategy (`stacked-to-main`, `feature-branch-chain`, or single branch `single-pr`) since forecast (~1,950 lines) exceeds ~400-line slice budget. Mirror: pending (Engram MCP unavailable).
- **L5 (2026-11-24)**: `"1"` — User selected `stacked-to-main`. Committing `T1` on `feat/pdf-pro-1-security` (`46e65ed`) and stacking `feat/pdf-pro-2-engine-perf` .. `feat/pdf-pro-6-mcp-ergonomics` sequentially.
- **L6 (2026-11-24)**: Completed **T2 (`S2`)**: JPEG preservation + 4 KB SVG header check + SHA-256 LRU cache in `imageProcessor.ts`, memoized `getComponentSchema()`, category-lean `list_pdf_components`, image/QR count + `InvoiceSummary` arithmetic + local asset checks in `validate.ts`, and single-pass `PDFDocument.load` code attachment in `render.tsx`/`generatePdf.ts`. Verified `47/43 -> 47/47` tests and `typecheck`.
