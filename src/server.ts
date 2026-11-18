import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPdfTools } from './tools/register.js';

export function createPdfMcpServer(): McpServer {
  const server = new McpServer({ name: 'mcp-pdf-server', version: '1.0.0' });
  registerPdfTools(server);
  return server;
}
