import { Command } from 'commander';
import { runMcpServer } from '../mcp/server.js';

export function registerMcpCommands(program: Command, getBackendUrl: () => string): void {
  const mcp = program.command('mcp').description('Model Context Protocol server commands');

  mcp
    .command('serve')
    .description('Run local MCP server over stdio')
    .option(
      '--auth-token <token>',
      'Optional token required by all MCP tool calls (defaults to OPENHW_MCP_TOKEN when set)'
    )
    .action(async (options: { authToken?: string }) => {
      await runMcpServer({
        backendUrl: getBackendUrl(),
        authToken: options.authToken || process.env.OPENHW_MCP_TOKEN || '',
      });
    });
}
