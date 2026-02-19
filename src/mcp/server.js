/**
 * MCP server — exposes snbatch capabilities as MCP tools.
 *
 * CRITICAL: This process communicates via stdout using JSON-RPC.
 * No non-JSON must be written to stdout. All display is suppressed via SNBATCH_MCP_MODE=1.
 */

// Set MCP mode BEFORE any other imports that might write to stdout
process.env.SNBATCH_MCP_MODE = '1';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

export async function startMcpServer() {
  const server = new McpServer(
    { name: 'snbatch', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running; process stays alive via stdio
}
