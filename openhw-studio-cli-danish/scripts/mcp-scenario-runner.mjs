import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(cliRoot, '..');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseArgs(argv) {
  const out = {
    scenario: '',
    backendUrl: String(process.env.MCP_TEST_BACKEND_URL || 'http://127.0.0.1:5001/api').trim(),
    token: String(process.env.OPENHW_MCP_TOKEN || '').trim(),
    outputJson: 'temp/mcp-scenario-report.json',
    outputMd: 'temp/mcp-scenario-report.md',
    baseline: '',
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--scenario') {
      out.scenario = String(argv[i + 1] || '');
      i += 1;
    } else if (arg === '--backend-url') {
      out.backendUrl = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (arg === '--token') {
      out.token = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (arg === '--output-json') {
      out.outputJson = String(argv[i + 1] || '');
      i += 1;
    } else if (arg === '--output-md') {
      out.outputMd = String(argv[i + 1] || '');
      i += 1;
    } else if (arg === '--baseline') {
      out.baseline = String(argv[i + 1] || '');
      i += 1;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    }
  }

  if (!out.scenario) {
    throw new Error('Usage: node scripts/mcp-scenario-runner.mjs --scenario <path> [--output-json <path>] [--output-md <path>] [--baseline <path>]');
  }

  return out;
}

function ensure(condition, message) {
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

  if (result?.isError) {
    throw new Error(`${toolName} returned isError=true${text ? `: ${text}` : ''}`);
  }

  ensure(parsed && typeof parsed === 'object', `${toolName} returned empty or non-JSON payload.`);
  return parsed;
}

async function callTool(client, name, args) {
  const response = await client.callTool({
    name,
    arguments: args,
  });
  return parseToolPayload(response, name);
}

async function readScenario(filePath) {
  const absolute = await (async () => {
    if (path.isAbsolute(filePath)) return filePath;
    const candidates = [
      path.resolve(process.cwd(), filePath),
      path.resolve(cliRoot, filePath),
      path.resolve(workspaceRoot, filePath),
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
  })();
  const raw = await fs.readFile(absolute, 'utf8');
  const ext = path.extname(absolute).toLowerCase();
  const parsed = ext === '.yaml' || ext === '.yml' ? YAML.parse(raw) : JSON.parse(raw);

  ensure(parsed && typeof parsed === 'object', 'Scenario must be a JSON/YAML object.');
  ensure(String(parsed.name || '').trim(), 'Scenario requires name.');
  ensure(String(parsed.board || '').trim(), 'Scenario requires board.');
  return {
    absolute,
    data: parsed,
  };
}

function parseLooseValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function resolveProjectPath(fileField) {
  const relative = String(fileField || '').trim();
  ensure(relative, 'project_init did not return file path.');
  if (path.isAbsolute(relative)) return relative;

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

async function configureEnvProjectFile(projectFile, envConfig) {
  if (!envConfig || typeof envConfig !== 'object') return;
  const boardEnv = String(envConfig.boardEnv || '').trim();
  const codeFile = String(envConfig.codeFile || '').trim();
  const source = String(envConfig.source || '');
  if (!boardEnv && !codeFile && !source) return;

  const raw = await fs.readFile(projectFile, 'utf8');
  const project = JSON.parse(raw);
  const board = Array.isArray(project?.components)
    ? project.components.find((entry) => String(entry?.id || '') === 'board1')
    : null;
  if (!board) return;

  if (!board.attrs || typeof board.attrs !== 'object' || Array.isArray(board.attrs)) {
    board.attrs = {};
  }

  if (boardEnv) {
    board.attrs.env = boardEnv;
    board.attrs.builder = 'arduino-pico';
  }

  if (codeFile) {
    if (!Array.isArray(project.projectFiles)) project.projectFiles = [];
    const existing = project.projectFiles.find((entry) => String(entry?.path || '') === codeFile);
    if (existing) {
      existing.content = source;
      existing.dirty = false;
    } else {
      project.projectFiles.push({
        id: codeFile,
        path: codeFile,
        name: path.posix.basename(codeFile.replace(/\\/g, '/')),
        kind: 'code',
        boardId: 'board1',
        boardKind: 'rp2040',
        content: source,
        dirty: false,
      });
    }
    project.code = source;
    project.activeCodeFileId = codeFile;
    if (!Array.isArray(project.openCodeTabs)) project.openCodeTabs = [];
    if (!project.openCodeTabs.includes(codeFile)) project.openCodeTabs.push(codeFile);
  }

  await fs.writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

function indexTrace(trace) {
  const componentTimeline = {};
  const boardPinTimeline = {};
  const serialEvents = [];

  for (const event of Array.isArray(trace) ? trace : []) {
    const tMs = Number(event?.tMs || 0);
    const boardId = String(event?.boardId || 'default');
    const type = String(event?.type || 'unknown');
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};

    if (type === 'state') {
      const pinKeys = Array.isArray(detail.pinKeys) ? detail.pinKeys.map((entry) => String(entry)) : [];
      if (!boardPinTimeline[boardId]) boardPinTimeline[boardId] = [];
      boardPinTimeline[boardId].push({ tMs, pinKeys });

      const components = Array.isArray(detail.components) ? detail.components : [];
      for (const component of components) {
        const id = String(component?.id || '').trim();
        if (!id) continue;
        if (!componentTimeline[id]) componentTimeline[id] = [];
        componentTimeline[id].push({
          tMs,
          boardId,
          stateKeys: Array.isArray(component?.stateKeys) ? component.stateKeys.map((key) => String(key)) : [],
          telemetrySummary: String(component?.telemetrySummary || ''),
        });
      }
    }

    if (type === 'serial') {
      serialEvents.push({
        tMs,
        boardId,
        source: String(detail.source || 'uart0'),
        length: Number(detail.length || 0),
        preview: typeof detail.data === 'string' ? String(detail.data).slice(0, 120) : '',
      });
    }
  }

  return {
    componentTimeline,
    boardPinTimeline,
    serialEvents,
  };
}

function safeText(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push(`# MCP Scenario Report: ${report.scenario.name}`);
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Scenario: ${report.scenario.file}`);
  lines.push(`- Backend: ${report.backendUrl}`);
  lines.push(`- Total cases: ${report.totals.total}`);
  lines.push(`- Passed: ${report.totals.passed}`);
  lines.push(`- Failed: ${report.totals.failed}`);
  if (report.behaviorDiff?.compared) {
    lines.push(`- Behavior diff changes: ${report.behaviorDiff.changedCount}`);
  }
  lines.push('');

  lines.push('## Case Results');
  lines.push('');
  lines.push('| Case | Env | Status | Components | Wires Planned | Wire Errors | Faults | Trace Events | Serial Events |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const entry of report.results) {
    lines.push(`| ${safeText(entry.caseName)} | ${safeText(entry.envKey)} | ${entry.ok ? 'PASS' : 'FAIL'} | ${Number(entry.telemetry?.componentCount || 0)} | ${Number(entry.wiring?.plannedCount || 0)} | ${Number(entry.wiring?.errorCount || 0)} | ${Number(entry.runtime?.faultCount || 0)} | ${Number(entry.trace?.capturedEvents || 0)} | ${Number(entry.serial?.eventCount || 0)} |`);
  }
  lines.push('');

  lines.push('## Connectivity Diagnostics');
  lines.push('');
  for (const entry of report.results) {
    lines.push(`### ${entry.caseName} / ${entry.envKey}`);
    lines.push(`- Planned wires: ${entry.wiring.plannedCount}`);
    lines.push(`- Applied wires: ${entry.wiring.appliedCount}`);
    if (entry.wiring.errors.length > 0) {
      lines.push('- Wire errors:');
      for (const wire of entry.wiring.errors) {
        lines.push(`  - ${wire.from} -> ${wire.to}: ${wire.error}`);
      }
    } else {
      lines.push('- Wire errors: none');
    }
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function maybeReadBaseline(filePath) {
  if (!filePath) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
  const raw = await fs.readFile(absolute, 'utf8');
  return JSON.parse(raw);
}

function computeBehaviorDiff(report, baseline) {
  if (!baseline || !Array.isArray(baseline?.results)) {
    return { compared: false, changedCount: 0, changedCases: [] };
  }

  const baselineByKey = new Map(
    baseline.results.map((entry) => [`${entry.caseName}::${entry.envKey}`, entry])
  );
  const changedCases = [];

  for (const entry of report.results) {
    const key = `${entry.caseName}::${entry.envKey}`;
    const before = baselineByKey.get(key);
    if (!before) {
      changedCases.push({ key, reason: 'missing-baseline-case' });
      continue;
    }

    const compareFields = {
      telemetryStatusById: entry.telemetry.statusById,
      traceEventTypeCounts: entry.trace.eventTypeCounts,
      faultCount: entry.runtime.faultCount,
      serialEventCount: entry.serial.eventCount,
    };

    const beforeFields = {
      telemetryStatusById: before?.telemetry?.statusById || {},
      traceEventTypeCounts: before?.trace?.eventTypeCounts || {},
      faultCount: Number(before?.runtime?.faultCount || 0),
      serialEventCount: Number(before?.serial?.eventCount || 0),
    };

    if (JSON.stringify(compareFields) !== JSON.stringify(beforeFields)) {
      changedCases.push({ key, reason: 'behavior-diff' });
    }
  }

  return {
    compared: true,
    changedCount: changedCases.length,
    changedCases,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const scenarioSpec = await readScenario(args.scenario);
  const scenario = scenarioSpec.data;

  const transport = new StdioClientTransport({
    command: npmCommand(),
    args: ['run', 'mcp', '--', '--backend-url', args.backendUrl],
    cwd: cliRoot,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'openhw-mcp-scenario-runner', version: '0.1.0' });

  const envs = Array.isArray(scenario.envs) && scenario.envs.length > 0
    ? scenario.envs
    : [{ key: 'default', boardEnv: '', ms: Number(scenario.durationMs || 1800) }];

  const components = Array.isArray(scenario.components) ? scenario.components : [];
  const wires = Array.isArray(scenario.wires) ? scenario.wires : [];
  const inspections = Array.isArray(scenario.inspect) ? scenario.inspect : [];
  const traceEventTypes = Array.isArray(scenario.traceEventTypes)
    ? scenario.traceEventTypes.map((entry) => String(entry || ''))
    : ['state', 'serial', 'fault', 'debug'];

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    backendUrl: args.backendUrl,
    scenario: {
      name: String(scenario.name),
      file: path.relative(workspaceRoot, scenarioSpec.absolute).replace(/\\/g, '/'),
      board: String(scenario.board),
    },
    results: [],
  };

  try {
    await client.connect(transport);

    await callTool(client, 'component_catalog', {
      ...(args.token ? { token: args.token } : {}),
    });

    for (const envConfig of envs) {
      const envKey = String(envConfig.key || envConfig.boardEnv || 'default');
      const durationMs = Number(envConfig.ms || scenario.durationMs || 1800);

      const initPayload = await callTool(client, 'project_init', {
        name: `${scenario.name}-${envKey}-${Date.now()}`,
        board: String(scenario.board),
        ...(args.token ? { token: args.token } : {}),
      });

      const projectFile = await resolveProjectPath(initPayload.file);
      await configureEnvProjectFile(projectFile, envConfig);

      const addedComponents = [];
      for (const component of components) {
        const added = await callTool(client, 'component_add', {
          type: String(component.type || ''),
          ...(component.id ? { id: String(component.id) } : {}),
          ...(Number.isFinite(Number(component.x)) ? { x: Number(component.x) } : {}),
          ...(Number.isFinite(Number(component.y)) ? { y: Number(component.y) } : {}),
          ...(args.token ? { token: args.token } : {}),
        });
        addedComponents.push(added?.component || null);
      }

      const wiringValidation = await callTool(client, 'wiring_validate', {
        wires: wires.map((wire) => ({
          from: String(wire.from || ''),
          to: String(wire.to || ''),
        })),
        ...(args.token ? { token: args.token } : {}),
      });

      const wireErrors = [];
      let appliedCount = 0;
      for (const wire of wires) {
        try {
          await callTool(client, 'wire_add', {
            from: String(wire.from || ''),
            to: String(wire.to || ''),
            ...(args.token ? { token: args.token } : {}),
          });
          appliedCount += 1;
        } catch (error) {
          wireErrors.push({
            from: String(wire.from || ''),
            to: String(wire.to || ''),
            error: String(error?.message || error),
          });
        }
      }

      const executePayload = args.dryRun
        ? {
          result: {
            elapsedMs: 0,
            faultCount: 0,
            serialChars: 0,
          },
          telemetry: {
            components: [],
          },
          trace: [],
          traceSummary: {
            droppedEvents: 0,
          },
          console: {
            length: 0,
          },
        }
        : await callTool(client, 'sim_execute', {
          ms: durationMs,
          all_boards: true,
          include_telemetry: true,
          include_trace: true,
          include_console: true,
          include_state: true,
          include_serial_text: true,
          trace_event_types: traceEventTypes,
          ...(args.token ? { token: args.token } : {}),
        });

      const trace = Array.isArray(executePayload.trace) ? executePayload.trace : [];
      const telemetry = executePayload.telemetry || executePayload.result?.telemetry || { components: [] };
      const telemetryComponents = Array.isArray(telemetry?.components) ? telemetry.components : [];

      const telemetryStatusById = {};
      for (const component of telemetryComponents) {
        telemetryStatusById[String(component?.id || '')] = String(component?.status || 'unknown');
      }

      const traceIndexed = indexTrace(trace);
      const eventTypeCounts = {};
      for (const event of trace) {
        const type = String(event?.type || 'unknown');
        eventTypeCounts[type] = Number(eventTypeCounts[type] || 0) + 1;
      }

      const inspectResults = [];
      for (const inspect of inspections) {
        if (args.dryRun) break;
        const inspectId = String(inspect.id || '').trim();
        if (!inspectId) continue;

        const inspectArgs = {
          id: inspectId,
          ms: Number(inspect.ms || Math.max(800, Math.floor(durationMs / 2))),
          all_boards: true,
          include_trace: !!inspect.includeTrace,
          include_console: !!inspect.includeConsole,
          ...(inspect.event !== undefined ? { event: inspect.event } : {}),
          ...(inspect.value !== undefined ? { value: parseLooseValue(inspect.value) } : {}),
          ...(Number.isFinite(Number(inspect.atMs)) ? { at_ms: Number(inspect.atMs) } : {}),
          ...(args.token ? { token: args.token } : {}),
        };

        const inspectPayload = await callTool(client, 'sim_inspect', inspectArgs);
        inspectResults.push({
          id: inspectId,
          ok: !!inspectPayload.ok,
          component: inspectPayload.component || null,
          eventProbe: inspectPayload.eventProbe || null,
        });
      }

      report.results.push({
        caseName: String(scenario.name),
        envKey,
        durationMs,
        projectFile: path.relative(workspaceRoot, projectFile).replace(/\\/g, '/'),
        addedComponents: addedComponents.filter(Boolean).map((entry) => ({ id: entry.id, type: entry.type })),
        wiring: {
          plannedCount: wires.length,
          appliedCount,
          errorCount: wireErrors.length,
          errors: wireErrors,
          diagnostics: wiringValidation?.diagnostics || [],
        },
        runtime: {
          elapsedMs: Number(executePayload?.result?.elapsedMs || 0),
          faultCount: Number(executePayload?.result?.faultCount || 0),
          serialChars: Number(executePayload?.result?.serialChars || 0),
        },
        telemetry: {
          componentCount: telemetryComponents.length,
          statusById: telemetryStatusById,
        },
        trace: {
          capturedEvents: trace.length,
          droppedEvents: Number(executePayload?.traceSummary?.droppedEvents || 0),
          eventTypeCounts,
          componentTimeline: traceIndexed.componentTimeline,
          boardPinTimeline: traceIndexed.boardPinTimeline,
        },
        serial: {
          eventCount: traceIndexed.serialEvents.length,
          events: traceIndexed.serialEvents,
          consoleLength: Number(executePayload?.console?.length || 0),
        },
        inspect: inspectResults,
        ok: wireErrors.length === 0,
      });
    }
  } finally {
    await client.close();
  }

  report.totals = {
    total: report.results.length,
    passed: report.results.filter((entry) => entry.ok).length,
    failed: report.results.filter((entry) => !entry.ok).length,
  };
  report.ok = report.totals.failed === 0;

  const baseline = await maybeReadBaseline(args.baseline);
  report.behaviorDiff = computeBehaviorDiff(report, baseline);

  if (report.behaviorDiff.compared && report.behaviorDiff.changedCount > 0) {
    report.ok = false;
  }

  const outputJsonAbsolute = path.isAbsolute(args.outputJson)
    ? args.outputJson
    : path.resolve(workspaceRoot, args.outputJson);
  const outputMdAbsolute = path.isAbsolute(args.outputMd)
    ? args.outputMd
    : path.resolve(workspaceRoot, args.outputMd);

  await fs.mkdir(path.dirname(outputJsonAbsolute), { recursive: true });
  await fs.mkdir(path.dirname(outputMdAbsolute), { recursive: true });

  await fs.writeFile(outputJsonAbsolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(outputMdAbsolute, buildMarkdownReport(report), 'utf8');

  console.log(`[mcp-scenario-runner] json=${path.relative(workspaceRoot, outputJsonAbsolute).replace(/\\/g, '/')}`);
  console.log(`[mcp-scenario-runner] md=${path.relative(workspaceRoot, outputMdAbsolute).replace(/\\/g, '/')}`);
  console.log(`[mcp-scenario-runner] total=${report.totals.total} passed=${report.totals.passed} failed=${report.totals.failed}`);
  if (args.dryRun) {
    console.log('[mcp-scenario-runner] mode=dry-run (simulation execution skipped)');
  }
  if (report.behaviorDiff?.compared) {
    console.log(`[mcp-scenario-runner] behavior-diff changed=${report.behaviorDiff.changedCount}`);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[mcp-scenario-runner] FAIL ${String(error?.message || error)}`);
  process.exit(1);
});
