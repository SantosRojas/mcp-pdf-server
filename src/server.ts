import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerPdfTools } from './tools/register.js';
import { getWorkspace, invalidateWorkspace } from './runtime/workspace.js';
import { config } from './config.js';

export function createPdfMcpServer(): McpServer {
  const server = new McpServer({ name: 'mcp-pdf-server', version: config.version });
  registerPdfTools(server);
  // MCP roots are the reliable way to know which project is using the server: a global
  // MCP config may spawn the process from a folder unrelated to the open project.
  server.server.oninitialized = () => {
    void getWorkspace(server).catch(() => undefined);
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    invalidateWorkspace(server);
    await getWorkspace(server).catch(() => undefined);
  });
  return server;
}
