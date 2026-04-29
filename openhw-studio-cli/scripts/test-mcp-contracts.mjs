import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');

const backendUrl = String(process.env.MCP_TEST_BACKEND_URL || 'http://127.0.0.1:5001/api').trim();
const token = String(process.env.OPENHW_MCP_TOKEN || '').trim();

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseToolPayload(result, toolName) {
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
    parsed,
    text,
    toolName,
  };
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return parseToolPayload(result, name);
}

async function main() {
  const transport = new StdioClientTransport({
    command: npmCommand(),
    args: ['run', 'mcp', '--', '--backend-url', backendUrl],
    cwd: cliRoot,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'openhw-mcp-contracts', version: '0.1.0' });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = new Set((listed?.tools || []).map((tool) => String(tool?.name || '')));

    for (const requiredTool of [
      'project_init',
      'project_open',
      'project_status',
      'project_validate',
      'component_catalog',
      'simulation_capabilities',
      'component_input_schema',
      'wiring_validate',
      'sim_execute',
      'sim_trace',
      'sim_inspect',
      'simulation_step',
      'simulation_assert',
    ]) {
      assert(toolNames.has(requiredTool), `Missing MCP tool ${requiredTool}`);
    }

    const statusBefore = await callTool(client, 'project_status', {
      ...(token ? { token } : {}),
    });
    assert(!statusBefore.isError, 'project_status should not error without active project.');
    assert(statusBefore.parsed?.ok === true, 'project_status should return ok=true.');

    const init = await callTool(client, 'project_init', {
      name: `contracts-${Date.now()}`,
      board: 'wokwi-raspberry-pi-pico',
      ...(token ? { token } : {}),
    });
    assert(!init.isError, 'project_init returned error.');
    assert(init.parsed?.ok === true, 'project_init should return ok=true.');

    const validate = await callTool(client, 'project_validate', {
      ...(token ? { token } : {}),
    });
    assert(!validate.isError, 'project_validate returned error.');
    assert(typeof validate.parsed?.ok === 'boolean', 'project_validate ok missing.');

    const catalog = await callTool(client, 'component_catalog', {
      ...(token ? { token } : {}),
    });
    assert(!catalog.isError, 'component_catalog returned error.');
    assert(Array.isArray(catalog.parsed?.components), 'component_catalog components missing.');

    const capabilities = await callTool(client, 'simulation_capabilities', {
      ...(token ? { token } : {}),
    });
    assert(!capabilities.isError, 'simulation_capabilities returned error.');
    assert(capabilities.parsed?.ok === true, 'simulation_capabilities should return ok=true.');
    assert(Array.isArray(capabilities.parsed?.project?.interactiveComponents), 'simulation_capabilities interactiveComponents missing.');

    const inputSchema = await callTool(client, 'component_input_schema', {
      ...(token ? { token } : {}),
    });
    assert(!inputSchema.isError, 'component_input_schema returned error.');
    assert(Array.isArray(inputSchema.parsed?.components), 'component_input_schema components missing.');

    const invalidWire = await callTool(client, 'wiring_validate', {
      from: 'board1:NOT_A_PIN',
      to: 'board1:GND',
      ...(token ? { token } : {}),
    });
    assert(!invalidWire.isError, 'wiring_validate contract response should not transport-error.');
    assert(invalidWire.parsed?.ok === false, 'wiring_validate invalid wire should return ok=false.');
    assert(Array.isArray(invalidWire.parsed?.diagnostics), 'wiring_validate diagnostics missing.');

    const simInspectNegative = await callTool(client, 'sim_inspect', {
      event: 'press',
      ms: 500,
      ...(token ? { token } : {}),
    });
    assert(simInspectNegative.isError, 'sim_inspect should return isError for event injection without id.');

    console.log('[mcp-contracts] PASS');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`[mcp-contracts] FAIL ${String(error?.message || error)}`);
  process.exit(1);
});
