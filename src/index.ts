#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPdfMcpServer } from './server.js';
import { startHttpTransport } from './transports/http.js';
import { config } from './config.js';

async function main(): Promise<void> {
  if (config.transport === 'http') {
    await startHttpTransport();
    return;
  }
  if (config.transport !== 'stdio') throw new Error(`PDF_MCP_TRANSPORT no soportado: ${config.transport}. Usa stdio o http.`);
  const server = createPdfMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-pdf-server listo por stdio. Los logs se envían a stderr.');
}

main().catch((error: unknown) => {
  console.error('[mcp-pdf-server] Fatal:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
