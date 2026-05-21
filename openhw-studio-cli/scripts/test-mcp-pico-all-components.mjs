import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(cliRoot, '..');
const emulatorComponentsRoot = path.join(workspaceRoot, 'openhw-studio-emulator', 'src', 'components');

const backendUrl = String(process.env.MCP_TEST_BACKEND_URL || 'http://127.0.0.1:5001/api').trim();
const token = String(process.env.OPENHW_MCP_TOKEN || '').trim();

const envMatrix = [
  {
    key: 'ino',
    boardEnv: 'native',
    durationMs: 7000,
    codeFile: 'project/board1/board1.ino',
    source: `#include <Arduino.h>\n\nvoid setup() {\n  Serial1.setTX(0);\n  Serial1.setRX(1);\n  Serial1.begin(115200);\n  Serial1.println("MCP_INO_BOOT");\n}\n\nvoid loop() {\n  delay(100);\n}\n`,
  },
  {
    key: 'micropython',
    boardEnv: 'micropython',
    durationMs: 8000,
    codeFile: 'project/board1/main.py',
    source: `from time import sleep\nprint("MCP_MP_BOOT")\nfor _ in range(8):\n  sleep(0.1)\n`,
  },
  {
    key: 'circuitpython',
    boardEnv: 'circuitpython',
    durationMs: 14000,
    codeFile: 'project/board1/code.py',
    source: `import time\nprint("MCP_CP_BOOT")\nfor _ in range(8):\n    time.sleep(0.1)\nprint("MCP_CP_DONE")\n`,
  },
];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

  if (result?.isError) {
    throw new Error(`${toolName} returned isError=true${text ? `: ${text}` : ''}`);
  }

  assert(parsed && typeof parsed === 'object', `${toolName} returned empty or non-JSON payload.`);
  assert(parsed.ok === true, `${toolName} did not return ok=true.`);
  return parsed;
}

async function callTool(client, name, args) {
  const response = await client.callTool({
    name,
    arguments: args,
  }, undefined, { timeout: 120000 });
  return parseToolPayload(response, name);
}

async function listComponentTypes() {
  const entries = await fs.readdir(emulatorComponentsRoot, { withFileTypes: true });
  const componentTypes = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const type = String(entry.name || '').trim();
    if (!type) continue;

    const manifestPath = path.join(emulatorComponentsRoot, type, 'manifest.json');
    try {
      await fs.access(manifestPath);
      componentTypes.push(type);
    } catch {
      continue;
    }
  }

  componentTypes.sort((a, b) => a.localeCompare(b));
  return componentTypes;
}

async function resolveProjectPathFromMcp(fileField) {
  const relative = String(fileField || '').trim();
  assert(relative.length > 0, 'project_init did not return file path.');

  if (path.isAbsolute(relative)) {
    return relative;
  }

  const normalized = relative.replace(/\\/g, '/');
  const candidates = [
    path.join(workspaceRoot, normalized),
    path.join(cliRoot, normalized),
    path.resolve(process.cwd(), normalized),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return candidates[0];
}

function ensureCodeFiles(project, sourceByPath) {
  if (!Array.isArray(project.projectFiles)) {
    project.projectFiles = [];
  }

  const byPath = new Map(project.projectFiles.map((file) => [String(file.path || ''), file]));

  for (const [filePath, source] of sourceByPath.entries()) {
    if (!byPath.has(filePath)) {
      const name = path.posix.basename(filePath.replace(/\\/g, '/'));
      const boardKind = filePath.toLowerCase().endsWith('.py') ? 'rp2040' : 'rp2040';
      const created = {
        id: filePath,
        path: filePath,
        name,
        kind: 'code',
        boardId: 'board1',
        boardKind,
        content: String(source),
        dirty: false,
      };
      project.projectFiles.push(created);
      byPath.set(filePath, created);
    } else {
      byPath.get(filePath).content = String(source);
      byPath.get(filePath).dirty = false;
    }
  }
}

async function updateProjectForEnv(projectFile, envConfig) {
  const raw = await fs.readFile(projectFile, 'utf8');
  const project = JSON.parse(raw);

  const board = Array.isArray(project.components)
    ? project.components.find((component) => String(component?.id || '') === 'board1')
    : null;

  assert(board, 'Unable to locate board1 in MCP project.');
  if (!board.attrs || typeof board.attrs !== 'object' || Array.isArray(board.attrs)) {
    board.attrs = {};
  }

  board.attrs.env = envConfig.boardEnv;
  board.attrs.builder = 'arduino-pico';

  const sourceByPath = new Map();
  for (const env of envMatrix) {
    sourceByPath.set(env.codeFile, env.source);
  }
  ensureCodeFiles(project, sourceByPath);

  project.code = envConfig.source;
  project.activeCodeFileId = envConfig.codeFile;

  if (!Array.isArray(project.openCodeTabs)) {
    project.openCodeTabs = [];
  }
  if (!project.openCodeTabs.includes(envConfig.codeFile)) {
    project.openCodeTabs.push(envConfig.codeFile);
  }

  await fs.writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

function countByStatus(components) {
  const counts = {};
  for (const component of components) {
    const status = String(component?.status || 'unknown');
    counts[status] = Number(counts[status] || 0) + 1;
  }
  return counts;
}

function readTelemetryComponents(payload) {
  if (Array.isArray(payload?.telemetry?.components)) {
    return payload.telemetry.components;
  }
  if (Array.isArray(payload?.result?.telemetry?.components)) {
    return payload.result.telemetry.components;
  }
  return [];
}

async function main() {
  const componentTypes = await listComponentTypes();
  assert(componentTypes.length > 0, 'No component manifests found under emulator components folder.');

  const command = npmCommand();
  const args = ['run', 'mcp', '--', '--backend-url', backendUrl];

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: cliRoot,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'openhw-mcp-pico-all-components', version: '0.1.0' });
  const runId = Date.now();
  const runName = `pico-all-components-${runId}`;

  const finalSummary = {
    ok: true,
    runId,
    backendUrl,
    generatedAt: new Date().toISOString(),
    projectFile: '',
    componentCatalogCount: componentTypes.length,
    componentTypes,
    envResults: [],
  };

  try {
    await client.connect(transport);

    const initPayload = await callTool(client, 'project_init', {
      name: runName,
      board: 'openhw-raspberry-pi-pico',
      ...(token ? { token } : {}),
    });

    const projectFile = await resolveProjectPathFromMcp(initPayload.file);
    finalSummary.projectFile = path.relative(workspaceRoot, projectFile).replace(/\\/g, '/');

    const addFailures = [];
    let offset = 0;

    for (const type of componentTypes) {
      if (/(openhw-arduino|openhw-esp32|openhw-stm32|openhw-raspberry-pi-pico)/i.test(type)) {
        continue;
      }

      const x = 340 + ((offset % 10) * 120);
      const y = 80 + (Math.floor(offset / 10) * 100);
      offset += 1;

      try {
        await callTool(client, 'component_add', {
          type,
          x,
          y,
          ...(token ? { token } : {}),
        });
      } catch (error) {
        addFailures.push({ type, error: String(error?.message || error) });
      }
    }

    if (addFailures.length > 0) {
      finalSummary.addFailures = addFailures;
    }

    for (const envConfig of envMatrix) {
      await updateProjectForEnv(projectFile, envConfig);

      const executePayload = await callTool(client, 'sim_execute', {
        ms: envConfig.durationMs,
        all_boards: true,
        include_telemetry: true,
        ...(token ? { token } : {}),
      });

      const telemetryComponents = readTelemetryComponents(executePayload);
      const telemetryById = new Map(
        telemetryComponents.map((component) => [String(component?.id || ''), component])
      );

      const rawProject = JSON.parse(await fs.readFile(projectFile, 'utf8'));
      const expectedComponentIds = Array.isArray(rawProject?.components)
        ? rawProject.components.map((component) => String(component?.id || '')).filter(Boolean)
        : [];

      const missingTelemetryIds = expectedComponentIds.filter((id) => !telemetryById.has(id));
      const emptyTelemetryDataIds = telemetryComponents
        .filter((component) => {
          const data = component?.telemetryData;
          if (!data || typeof data !== 'object' || Array.isArray(data)) return true;
          return Object.keys(data).length === 0;
        })
        .map((component) => String(component?.id || ''));

      const missingSummaryIds = telemetryComponents
        .filter((component) => !String(component?.telemetrySummary || '').trim())
        .map((component) => String(component?.id || ''));

      const envResult = {
        env: envConfig.key,
        boardEnv: envConfig.boardEnv,
        durationMs: envConfig.durationMs,
        expectedComponents: expectedComponentIds.length,
        telemetryComponents: telemetryComponents.length,
        missingTelemetryCount: missingTelemetryIds.length,
        emptyTelemetryDataCount: emptyTelemetryDataIds.length,
        missingSummaryCount: missingSummaryIds.length,
        statusCounts: countByStatus(telemetryComponents),
        missingTelemetryIds,
        emptyTelemetryDataIds,
        missingSummaryIds,
      };

      finalSummary.envResults.push(envResult);
    }

    finalSummary.ok = finalSummary.envResults.every((envResult) => envResult.missingTelemetryCount === 0);
  } finally {
    await client.close();
  }

  const outPath = path.join(workspaceRoot, 'temp', 'mcp-pico-all-components-summary.json');
  await fs.writeFile(outPath, `${JSON.stringify(finalSummary, null, 2)}\n`, 'utf8');

  console.log(`[mcp-pico-all-components] summary=${path.relative(workspaceRoot, outPath).replace(/\\/g, '/')}`);
  for (const envResult of finalSummary.envResults) {
    console.log(
      `[mcp-pico-all-components] env=${envResult.env} expected=${envResult.expectedComponents} telemetry=${envResult.telemetryComponents} missing=${envResult.missingTelemetryCount} emptyTelemetryData=${envResult.emptyTelemetryDataCount}`
    );
  }

  if (!finalSummary.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[mcp-pico-all-components] FAIL ${String(error?.stack || error)}`);
  process.exit(1);
});
