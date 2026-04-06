import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');

const backendUrl = String(process.env.MCP_SMOKE_BACKEND_URL || 'http://127.0.0.1:5000').trim();
const requireSimulation = String(process.env.MCP_SMOKE_REQUIRE_SIM || '1').trim() !== '0';
const token = String(process.env.OPENHW_MCP_TOKEN || '').trim();

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseToolPayload(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((entry) => String(entry?.type || '') === 'text')
    .map((entry) => String(entry?.text || ''))
    .join('\n')
    .trim();

  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  return {
    isError: !!result?.isError,
    text,
    parsed,
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const command = npmCommand();
  const args = ['run', 'mcp', '--', '--backend-url', backendUrl];

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: cliRoot,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'openhw-mcp-smoke', version: '0.1.0' });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = new Set((listed?.tools || []).map((tool) => String(tool?.name || '')));

    const requiredTools = ['project_init', 'sim_execute', 'sim_trace', 'sim_inspect'];
    for (const toolName of requiredTools) {
      assert(toolNames.has(toolName), `Missing MCP tool: ${toolName}`);
    }

    const initArgs = {
      name: `smoke-${Date.now()}`,
      board: 'wokwi-raspberry-pi-pico',
      ...(token ? { token } : {}),
    };

    const initResult = await client.callTool({
      name: 'project_init',
      arguments: initArgs,
    });
    const initParsed = parseToolPayload(initResult);
    assert(!initParsed.isError, 'project_init returned isError=true');
    assert(initParsed.parsed && initParsed.parsed.ok === true, 'project_init did not return ok=true');

    if (requireSimulation) {
      const simArgs = {
        ms: 250,
        include_telemetry: true,
        all_boards: true,
        ...(token ? { token } : {}),
      };

      const simResult = await client.callTool({
        name: 'sim_execute',
        arguments: simArgs,
      });
      const simParsed = parseToolPayload(simResult);
      assert(!simParsed.isError, 'sim_execute returned isError=true');
      assert(simParsed.parsed && simParsed.parsed.ok === true, 'sim_execute did not return ok=true');
      assert(simParsed.parsed?.result && typeof simParsed.parsed.result === 'object', 'sim_execute result payload missing');

      console.log('[mcp-smoke] sim_execute ok=true');
    } else {
      console.log('[mcp-smoke] sim_execute skipped (MCP_SMOKE_REQUIRE_SIM=0)');
    }

    console.log(`[mcp-smoke] tools=${Array.from(toolNames).sort((a, b) => a.localeCompare(b)).join(',')}`);
    console.log('[mcp-smoke] PASS');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`[mcp-smoke] FAIL ${String(error?.message || error)}`);
  process.exit(1);
});
