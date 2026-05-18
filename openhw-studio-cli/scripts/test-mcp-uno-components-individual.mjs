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
    key: 'arduino',
    boardEnv: 'arduino',
    durationMs: 1800,
    codeFile: 'project/board1/main.ino',
    source: `#include <Arduino.h>
void setup() {
  Serial.begin(115200);
  Serial.println("MCP_ARDUINO_COMPONENT_BOOT");
}
void loop() {
  static int i = 0;
  Serial.print("MCP_ARDUINO_COMPONENT_STEP ");
  Serial.println(i++);
  delay(50);
  if (i > 6) while(true) delay(1000);
}
`,
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
  });
  return parseToolPayload(response, name);
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
      const created = {
        id: filePath,
        path: filePath,
        name,
        kind: 'code',
        boardId: 'board1',
        boardKind: 'arduino-uno',
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
  board.attrs.builder = 'arduino-uno';

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

function normalizePinName(value) {
  return String(value || '').trim().toUpperCase();
}

function findPin(pinNames, predicate) {
  return pinNames.find((pin) => predicate(normalizePinName(pin))) || null;
}

function buildWirePlan(pinNames) {
  const hasPin = (name) => pinNames.includes(name);
  const wires = [];
  const seen = new Set();
  const add = (from, to) => {
    const key = `${from}=>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    wires.push({ from, to });
  };

  const gndPin = findPin(pinNames, (pin) => pin === 'GND' || pin === 'K' || pin === 'C');
  const vccPin = findPin(pinNames, (pin) => /^(VCC|VDD|VIN|V\+|A|5V|3V3|3\.3V|LED)$/.test(pin));
  if (gndPin) add('board1:GND', `uut:${gndPin}`);
  if (vccPin) add('board1:5V', `uut:${vccPin}`);

  const sdaPin = findPin(pinNames, (pin) => pin === 'SDA');
  const sclPin = findPin(pinNames, (pin) => pin === 'SCL');
  if (sdaPin) add('board1:A4', `uut:${sdaPin}`);
  if (sclPin) add('board1:A5', `uut:${sclPin}`);

  const mosiPin = findPin(pinNames, (pin) => pin === 'MOSI' || pin === 'DIN');
  const misoPin = findPin(pinNames, (pin) => pin === 'MISO' || pin === 'DOUT');
  const sckPin = findPin(pinNames, (pin) => pin === 'SCK' || pin === 'CLK');
  const csPin = findPin(pinNames, (pin) => pin === 'CS' || pin === 'SS');
  if (mosiPin) add('board1:11', `uut:${mosiPin}`);
  if (misoPin) add('board1:12', `uut:${misoPin}`);
  if (sckPin) add('board1:13', `uut:${sckPin}`);
  if (csPin) add('board1:10', `uut:${csPin}`);

  const rxPin = findPin(pinNames, (pin) => pin === 'RX' || pin === 'RXD');
  const txPin = findPin(pinNames, (pin) => pin === 'TX' || pin === 'TXD');
  if (rxPin) add('board1:0', `uut:${rxPin}`);
  if (txPin) add('board1:1', `uut:${txPin}`);

  const signalPin = findPin(pinNames, (pin) => (
    pin === 'A'
    || pin === 'ANODE'
    || pin === 'SIG'
    || pin === 'IN'
    || pin === 'OUT'
    || pin === 'PWM'
    || pin === 'DATA'
  ));
  if (signalPin) add('board1:2', `uut:${signalPin}`);

  if (wires.length === 0) {
    const fallback = findPin(pinNames, (pin) => (
      !['GND', 'VCC', 'VDD', 'VIN', '5V', '3V3', '3.3V'].includes(pin)
    ));
    if (fallback) {
      add('board1:2', `uut:${fallback}`);
    }
  }

  return wires;
}

async function listComponentCatalog() {
  const entries = await fs.readdir(emulatorComponentsRoot, { withFileTypes: true });
  const components = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const type = String(entry.name || '').trim();
    if (!type) continue;
    if (/(openhw-arduino|openhw-esp32|openhw-stm32|openhw-raspberry-pi-pico)/i.test(type)) continue;

    const manifestPath = path.join(emulatorComponentsRoot, type, 'manifest.json');
    try {
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);
      const pinNames = Array.isArray(manifest?.pins)
        ? manifest.pins.map((pin) => String(pin?.id || '').trim()).filter(Boolean)
        : [];
      components.push({
        type,
        pinNames,
      });
    } catch {
      continue;
    }
  }

  components.sort((a, b) => a.type.localeCompare(b.type));
  return components;
}

function readTelemetryComponents(payload) {
  if (Array.isArray(payload?.telemetry?.components)) return payload.telemetry.components;
  if (Array.isArray(payload?.result?.telemetry?.components)) return payload.result.telemetry.components;
  return [];
}

async function runSingleCase(client, component, envConfig) {
  const initPayload = await callTool(client, 'project_init', {
    name: `uno-${envConfig.key}-${component.type}-${Date.now()}`,
    board: 'openhw-arduino-uno',
    ...(token ? { token } : {}),
  });
  const projectFile = await resolveProjectPathFromMcp(initPayload.file);

  await callTool(client, 'component_add', {
    type: component.type,
    id: 'uut',
    x: 360,
    y: 120,
    ...(token ? { token } : {}),
  });

  const wirePlan = buildWirePlan(component.pinNames);
  const wireErrors = [];
  for (const wire of wirePlan) {
    try {
      await callTool(client, 'wire_add', {
        from: wire.from,
        to: wire.to,
        ...(token ? { token } : {}),
      });
    } catch (error) {
      wireErrors.push({
        from: wire.from,
        to: wire.to,
        error: String(error?.message || error),
      });
    }
  }

  await updateProjectForEnv(projectFile, envConfig);

  const executePayload = await callTool(client, 'sim_execute', {
    ms: envConfig.durationMs,
    all_boards: true,
    include_telemetry: true,
    ...(token ? { token } : {}),
  });

  const telemetryComponents = readTelemetryComponents(executePayload);
  const telemetryById = new Map(
    telemetryComponents.map((entry) => [String(entry?.id || ''), entry])
  );
  const uutTelemetry = telemetryById.get('uut') || null;

  return {
    ok: !!uutTelemetry,
    env: envConfig.key,
    boardEnv: envConfig.boardEnv,
    componentType: component.type,
    pinCount: component.pinNames.length,
    plannedWires: wirePlan,
    wireErrorCount: wireErrors.length,
    wireErrors,
    telemetryFound: !!uutTelemetry,
    telemetryStatus: String(uutTelemetry?.status || ''),
    telemetrySummary: String(uutTelemetry?.telemetrySummary || ''),
    componentCount: telemetryComponents.length,
    durationMs: envConfig.durationMs,
  };
}

async function main() {
  const components = await listComponentCatalog();
  assert(components.length > 0, 'No component manifests found for individual UNO tests.');

  const transport = new StdioClientTransport({
    command: npmCommand(),
    args: ['run', 'mcp', '--', '--backend-url', backendUrl],
    cwd: cliRoot,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'openhw-mcp-uno-components-individual', version: '0.1.0' });

  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    backendUrl,
    envs: envMatrix.map((entry) => entry.key),
    componentCount: components.length,
    results: [],
  };

  try {
    await client.connect(transport);
    for (const envConfig of envMatrix) {
      for (const component of components) {
        try {
          const result = await runSingleCase(client, component, envConfig);
          summary.results.push(result);
          const state = result.ok ? 'PASS' : 'FAIL';
          console.log(`[mcp-uno-components-individual] ${state} env=${envConfig.key} component=${component.type} wires=${result.plannedWires.length} wireErrors=${result.wireErrorCount}`);
        } catch (error) {
          summary.results.push({
            ok: false,
            env: envConfig.key,
            boardEnv: envConfig.boardEnv,
            componentType: component.type,
            error: String(error?.message || error),
          });
          console.log(`[mcp-uno-components-individual] FAIL env=${envConfig.key} component=${component.type} error=${String(error?.message || error)}`);
        }
      }
    }
  } finally {
    await client.close();
  }

  const totals = {
    total: summary.results.length,
    passed: summary.results.filter((entry) => entry.ok).length,
    failed: summary.results.filter((entry) => !entry.ok).length,
  };
  summary.totals = totals;
  summary.ok = totals.failed === 0;

  const outDir = path.join(workspaceRoot, 'temp');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'mcp-uno-components-individual-summary.json');
  await fs.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`[mcp-uno-components-individual] summary=${path.relative(workspaceRoot, outPath).replace(/\\/g, '/')}`);
  console.log(`[mcp-uno-components-individual] total=${totals.total} passed=${totals.passed} failed=${totals.failed}`);

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
