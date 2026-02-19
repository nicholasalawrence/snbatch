/**
 * MCP server — exposes snbatch capabilities as MCP tools.
 *
 * CRITICAL: This process communicates via stdout using JSON-RPC.
 * No non-JSON must be written to stdout. All display is suppressed via SNBATCH_MCP_MODE=1.
 */

// Set MCP mode BEFORE any other imports that might write to stdout
process.env.SNBATCH_MCP_MODE = '1';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools.js';

export async function startMcpServer() {
  const server = new Server(
    { name: 'snbatch', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }) }],
        isError: true,
      };
    }

    try {
      const parsed = tool.inputSchema.parse(request.params.arguments ?? {});
      return await tool.handler(parsed);
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running; process stays alive via stdio
}
