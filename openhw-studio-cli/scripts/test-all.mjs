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
    key: 'uno',
    boardModel: 'wokwi-arduino-uno',
    boardKind: 'avr',
    boardEnv: 'arduino',
    durationMs: 1500,
    builder: 'arduino-cli',
    codeFile: 'project/board1/board1.ino',
    source: `void setup() { Serial.begin(115200); Serial.println("UNO_BOOT"); }\nvoid loop() { Serial.println("UNO_STEP"); delay(50); }\n`
  },
  {
    key: 'micropython',
    boardModel: 'wokwi-raspberry-pi-pico',
    boardKind: 'rp2040',
    boardEnv: 'micropython',
    durationMs: 1800,
    builder: 'arduino-pico',
    codeFile: 'project/board1/main.py',
    source: `from time import sleep\nprint("MCP_MP_COMPONENT_BOOT")\nfor i in range(6):\n  print("MCP_MP_COMPONENT_STEP", i)\n  sleep(0.05)\n`,
  },
  {
    key: 'circuitpython',
    boardModel: 'wokwi-raspberry-pi-pico',
    boardKind: 'rp2040',
    boardEnv: 'circuitpython',
    durationMs: 2400,
    builder: 'arduino-pico',
    codeFile: 'project/board1/code.py',
    source: `import time\nprint("MCP_CP_COMPONENT_BOOT")\nfor i in range(6):\n    print("MCP_CP_COMPONENT_STEP", i)\n    time.sleep(0.05)\nprint("MCP_CP_COMPONENT_DONE")\n`,
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
        boardKind: 'rp2040',
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
  board.attrs.builder = envConfig.builder;

  const sourceByPath = new Map();
  sourceByPath.set(envConfig.codeFile, envConfig.source);
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

function buildWirePlan(pinNames, boardKey) {
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
  
  const sdaPin = findPin(pinNames, (pin) => pin === 'SDA');
  const sclPin = findPin(pinNames, (pin) => pin === 'SCL');
  
  const mosiPin = findPin(pinNames, (pin) => pin === 'MOSI' || pin === 'DIN');
  const misoPin = findPin(pinNames, (pin) => pin === 'MISO' || pin === 'DOUT');
  const sckPin = findPin(pinNames, (pin) => pin === 'SCK' || pin === 'CLK');
  const csPin = findPin(pinNames, (pin) => pin === 'CS' || pin === 'SS');
  
  const rxPin = findPin(pinNames, (pin) => pin === 'RX' || pin === 'RXD');
  const txPin = findPin(pinNames, (pin) => pin === 'TX' || pin === 'TXD');
  
  const signalPin = findPin(pinNames, (pin) => (
    pin === 'A' || pin === 'ANODE' || pin === 'SIG' || pin === 'IN' || pin === 'OUT' || pin === 'PWM' || pin === 'DATA'
  ));

  if (boardKey === 'uno') {
    if (gndPin) add('board1:gnd_1', `uut:${gndPin}`);
    if (vccPin) add('board1:5V', `uut:${vccPin}`);
    if (sdaPin) add('board1:A4', `uut:${sdaPin}`);
    if (sclPin) add('board1:A5', `uut:${sclPin}`);
    if (mosiPin) add('board1:11', `uut:${mosiPin}`);
    if (misoPin) add('board1:12', `uut:${misoPin}`);
    if (sckPin) add('board1:13', `uut:${sckPin}`);
    if (csPin) add('board1:10', `uut:${csPin}`);
    if (rxPin) add('board1:0', `uut:${rxPin}`);
    if (txPin) add('board1:1', `uut:${txPin}`);
    if (signalPin) add('board1:2', `uut:${signalPin}`);
  } else {
    // Pico mapping
    if (gndPin) add('board1:GND', `uut:${gndPin}`);
    if (vccPin) add('board1:3V3', `uut:${vccPin}`);
    if (sdaPin) add('board1:GP4', `uut:${sdaPin}`);
    if (sclPin) add('board1:GP5', `uut:${sclPin}`);
    if (mosiPin) add('board1:GP19', `uut:${mosiPin}`);
    if (misoPin) add('board1:GP16', `uut:${misoPin}`);
    if (sckPin) add('board1:GP18', `uut:${sckPin}`);
    if (csPin) add('board1:GP17', `uut:${csPin}`);
    if (rxPin) add('board1:GP0', `uut:${rxPin}`);
    if (txPin) add('board1:GP1', `uut:${txPin}`);
    if (signalPin) add('board1:GP2', `uut:${signalPin}`);
  }

  if (wires.length === 0) {
    const fallback = findPin(pinNames, (pin) => (!['GND', 'VCC', 'VDD', 'VIN', '5V', '3V3', '3.3V'].includes(pin)));
    if (fallback) {
      add(`board1:${boardKey === 'uno' ? '2' : 'GP2'}`, `uut:${fallback}`);
    }
  }

  return wires;
}

async function listComponentCatalog() {
  // Use the standard emulator dir, which should have the components. Wait, workspace has openhw-studio-emulator, maybe they use that.
  let components = [];
  try {
    const entries = await fs.readdir(emulatorComponentsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const type = String(entry.name || '').trim();
      if (!type) continue;
      if (/(wokwi-arduino|wokwi-esp32|wokwi-stm32|wokwi-raspberry-pi-pico)/i.test(type)) continue;

      const manifestPath = path.join(emulatorComponentsRoot, type, 'manifest.json');
      try {
        const manifestRaw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw);
        const pinNames = Array.isArray(manifest?.pins)
          ? manifest.pins.map((pin) => String(pin?.id || '').trim()).filter(Boolean)
          : [];
        components.push({ type, pinNames });
      } catch {
        continue;
      }
    }
  } catch(e) {
    console.log("Could not read emulator dir: " + e.message);
  }
  return components;
}

function readTelemetryComponents(payload) {
  if (Array.isArray(payload?.telemetry?.components)) return payload.telemetry.components;
  if (Array.isArray(payload?.result?.telemetry?.components)) return payload.result.telemetry.components;
  return [];
}

async function runSingleCase(client, component, envConfig) {
  const initPayload = await callTool(client, 'project_init', {
    name: `tests-all-${envConfig.key}-${component.type}-${Date.now()}`,
    board: envConfig.boardModel,
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

  const wirePlan = buildWirePlan(component.pinNames, envConfig.key);
  const wireErrors = [];
  for (const wire of wirePlan) {
    try {
      await callTool(client, 'wire_add', {
        from: wire.from,
        to: wire.to,
        ...(token ? { token } : {}),
      });
    } catch (error) {
      wireErrors.push({ from: wire.from, to: wire.to, error: String(error?.message || error) });
    }
  }

  await updateProjectForEnv(projectFile, envConfig);

  const executePayload = await callTool(client, 'sim_execute', {
    ms: envConfig.durationMs,
    all_boards: true,
    include_telemetry: true,
    custom_components_dir: path.join(workspaceRoot, 'openhw-studio-examples', 'custom-components'),
    ...(token ? { token } : {}),
  });

  const telemetryComponents = readTelemetryComponents(executePayload);
  const uutTelemetry = telemetryComponents.find(c => String(c?.id) === 'uut') || null;

  return {
    ok: !!uutTelemetry,
    env: envConfig.key,
    componentType: component.type,
    wireErrorCount: wireErrors.length,
    wireErrors,
    error: !uutTelemetry ? 'No telemetry found for uut' : null,
  };
}

async function main() {
  const components = await listComponentCatalog();
  // if no components, maybe use fallback list? 
  // Add some fallback dummy just in case for testing
  if (components.length === 0) {
      console.log('No builtin components found, trying fallback list...');
      components.push({type: 'wokwi-led', pinNames: ['A', 'C']});
      components.push({type: 'wokwi-pushbutton', pinNames: ['1.L', '1.R']});
  }
  
  // Adding custom components
  components.push({type: 'max30102', pinNames: ['VIN', 'SCL', 'SDA', 'INT', 'GND']});
  components.push({type: 'wokwi-spi-radio', pinNames: ['GND', 'VCC', 'CE', 'CSN', 'SCK', 'MOSI', 'MISO', 'IRQ']});

  const transport = new StdioClientTransport({
    command: npmCommand(),
    args: ['run', 'mcp', '--', '--backend-url', backendUrl],
    cwd: cliRoot,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'openhw-mcp-tests-all', version: '0.1.0' });

  const problems = [];

  try {
    await client.connect(transport);
    for (const envConfig of envMatrix) {
      for (const component of components) {
        try {
          const result = await runSingleCase(client, component, envConfig);
          if (!result.ok || result.wireErrorCount > 0) {
             problems.push({env: envConfig.key, component: component.type, error: result.error, wireErrors: result.wireErrors});
             console.log(`[test] FAIL env=${envConfig.key} comp=${component.type} error=${result.error} wireErrors=${JSON.stringify(result.wireErrors)}`);
          } else {
             console.log(`[test] PASS env=${envConfig.key} comp=${component.type}`);
          }
        } catch (error) {
          problems.push({env: envConfig.key, component: component.type, error: String(error?.message || error)});
          console.log(`[test] ERROR env=${envConfig.key} comp=${component.type} - ${error.message}`);
        }
      }
    }
  } finally {
    await client.close();
  }
  
  console.log('--- TEST RESULTS ---');
  if (problems.length > 0) {
      console.log(`Found ${problems.length} problems:`);
      problems.forEach(p => {
          console.log(`- [${p.env}] ${p.component}: ${p.error || 'Failed'}`);
      });
  } else {
      console.log('All tests passed with no problems.');
  }
}

main().catch(console.error);