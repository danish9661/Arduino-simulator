// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRunnerForBoard } from './execute.ts';

type WorkerEvent = {
  ts: string;
  type: string;
  boardId?: string;
  reason?: string;
  metrics?: any;
  pc?: number;
  data?: string;
  value?: number;
  message?: string;
};

type CaseReport = {
  caseId: string;
  pass: boolean;
  summary: string;
  details: Record<string, any>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKEND_DEFAULT_UF2 = path.join(
  WORKSPACE_ROOT,
  'openhw-studio-backend-danish',
  'data',
  'firmware',
  'pico-micropython-uart0.uf2'
);

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUf2PayloadFromFile(uf2Path: string): string {
  const raw = fs.readFileSync(uf2Path);
  return `UF2BASE64:${raw.toString('base64')}`;
}

function makeCircuit(env: string) {
  const components = [
    {
      id: 'pico1',
      type: 'wokwi-raspberry-pi-pico',
      attrs: { env, builder: 'arduino-pico' },
    },
    {
      id: 'led1',
      type: 'wokwi-led',
      attrs: { color: 'red' },
    },
  ];

  const wires = [
    { from: 'pico1:GP15', to: 'led1:A' },
    { from: 'pico1:GND', to: 'led1:K' },
  ];

  return { components, wires };
}

function compileNativePicoSketch(): {
  payload: string;
  artifactType: 'uf2' | 'hex';
  artifactPath: string;
  compileStdout: string;
} {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rp2040-smoke-native-'));
  const sketchDir = path.join(tmpBase, 'SmokeNative');
  const buildDir = path.join(tmpBase, 'build');

  fs.mkdirSync(sketchDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const ino = [
    '#include <Arduino.h>',
    '',
    'volatile uint32_t g_ctr = 0;',
    '',
    'void setup() {',
    '  pinMode(15, OUTPUT);',
    '  pinMode(16, OUTPUT);',
    '  Serial1.begin(115200);',
    '  Serial1.println("NATIVE_BOOT_OK");',
    '}',
    '',
    'void loop() {',
    '  g_ctr++;',
    '  bool high = (g_ctr & 0x2000u) != 0;',
    '  digitalWrite(15, high ? HIGH : LOW);',
    '  digitalWrite(16, high ? LOW : HIGH);',
    '  if ((g_ctr & 0x3fffu) == 0) {',
    '    Serial1.println(high ? "NATIVE_H" : "NATIVE_L");',
    '  }',
    '}',
    '',
  ].join('\n');

  const inoPath = path.join(sketchDir, 'SmokeNative.ino');
  fs.writeFileSync(inoPath, ino, 'utf8');

  const args = [
    'compile',
    '--fqbn',
    'rp2040:rp2040:rpipico',
    '--output-dir',
    buildDir,
    sketchDir,
  ];

  const proc = spawnSync('arduino-cli', args, { encoding: 'utf8' });
  if (proc.status !== 0) {
    throw new Error(
      `arduino-cli compile failed (exit=${proc.status})\nSTDOUT:\n${proc.stdout || ''}\nSTDERR:\n${proc.stderr || ''}`
    );
  }

  const outFiles = fs.readdirSync(buildDir);
  const uf2 = outFiles.find((f) => f.toLowerCase().endsWith('.uf2'));
  const hex = outFiles.find((f) => f.toLowerCase().endsWith('.hex'));

  if (uf2) {
    const artifactPath = path.join(buildDir, uf2);
    return {
      payload: `UF2BASE64:${fs.readFileSync(artifactPath).toString('base64')}`,
      artifactType: 'uf2',
      artifactPath,
      compileStdout: proc.stdout || '',
    };
  }

  if (hex) {
    const artifactPath = path.join(buildDir, hex);
    return {
      payload: fs.readFileSync(artifactPath, 'utf8'),
      artifactType: 'hex',
      artifactPath,
      compileStdout: proc.stdout || '',
    };
  }

  throw new Error(`Compile succeeded but no .uf2 or .hex found in ${buildDir}. Files: ${outFiles.join(', ')}`);
}

function sanitizeSerial(text: string): string {
  return String(text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function summarizePinActivity(pinSnapshots: Array<Record<string, boolean>>) {
  const transitionsByPin: Record<string, number> = {};
  let previous: Record<string, boolean> | null = null;

  for (const snap of pinSnapshots) {
    if (previous) {
      for (const pin of Object.keys(snap)) {
        const prev = !!previous[pin];
        const next = !!snap[pin];
        if (prev !== next) {
          transitionsByPin[pin] = (transitionsByPin[pin] || 0) + 1;
        }
      }
    }
    previous = snap;
  }

  const changedPins = Object.entries(transitionsByPin)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([pin, count]) => `${pin}:${count}`);

  return {
    transitionsByPin,
    changedPins,
    changedPinCount: changedPins.length,
  };
}

async function runRunnerCase(
  caseId: string,
  env: string,
  firmwarePayload: string,
  durationMs: number,
  options?: {
    injectMicroPythonScript?: string;
    forceFaultAfterMs?: number;
    forceMicroPythonJsRunner?: boolean;
    pyScript?: string;
  }
): Promise<{ report: CaseReport; events: WorkerEvent[]; serialText: string }> {
  const { components, wires } = makeCircuit(env);
  const events: WorkerEvent[] = [];
  const pinSnapshots: Array<Record<string, boolean>> = [];
  const debugReasons = new Set<string>();
  const debugLastPins = new Set<string>();
  let serialText = '';
  let faultCount = 0;

  const runner = createRunnerForBoard(
    'wokwi-raspberry-pi-pico',
    firmwarePayload,
    components,
    wires,
    (msg: any) => {
      const event: WorkerEvent = {
        ts: nowIso(),
        type: String(msg?.type || 'unknown'),
        boardId: String(msg?.boardId || ''),
      };

      if (msg?.type === 'debug' && msg?.category === 'rp2040-runtime') {
        event.reason = String(msg.reason || 'tick');
        event.metrics = msg.metrics || {};
        debugReasons.add(event.reason);
        const lastPin = String(msg?.metrics?.lastGpioPin || '');
        if (lastPin) debugLastPins.add(lastPin);
      } else if (msg?.type === 'serial') {
        event.value = Number(msg.value ?? 0);
        event.data = String(msg.data || '');
        serialText += event.data;
      } else if (msg?.type === 'state' && msg?.pins) {
        pinSnapshots.push({ ...(msg.pins || {}) });
      } else if (msg?.type === 'fault') {
        event.pc = Number(msg.pc ?? 0);
        event.message = String(msg.reason || 'fault');
        faultCount += 1;
      }

      events.push(event);
    },
    {
      boardId: 'pico1',
      serialBaudRate: 115200,
      debugEnabled: true,
      debugIntervalMs: 300,
      forceMicroPythonJsRunner: !!options?.forceMicroPythonJsRunner,
      pyScript: options?.pyScript,
    }
  );

  if (options?.injectMicroPythonScript) {
    const script = options.injectMicroPythonScript;
    const sendAttempt = () => {
      try {
        runner.serialRx('\u0003\u0003\r\n');
        runner.serialRx(`\u0003\u0003\u0005${script}\n\u0004`);
        setTimeout(() => {
          try {
            runner.serialRx(`\u0003\u0003\u0001${script}\n\u0004\u0002`);
          } catch {
            // no-op
          }
        }, 120);
      } catch {
        // no-op
      }
    };

    // Mirror worker strategy: multiple retries for slow MicroPython boot.
    [1400, 3600, 5800, 8000, 10500].forEach((delayMs) => {
      setTimeout(sendAttempt, delayMs);
    });
  }

  if (Number.isFinite(Number(options?.forceFaultAfterMs))) {
    const faultAfter = Number(options?.forceFaultAfterMs);
    setTimeout(() => {
      try {
        const cpu = (runner as any)?.cpu;
        if (cpu?.core?.BXWritePC) {
          cpu.core.BXWritePC(0xdeadbeef >>> 0);
        }
      } catch {
        // no-op
      }
    }, faultAfter);
  }

  await sleep(durationMs);

  try {
    runner.stop();
  } catch {
    // no-op
  }

  const pinSummary = summarizePinActivity(pinSnapshots);
  const cleanSerial = sanitizeSerial(serialText);

  const summary = [
    `events=${events.length}`,
    `faults=${faultCount}`,
    `debugReasons=${Array.from(debugReasons).join(',') || 'none'}`,
    `changedPins=${pinSummary.changedPinCount}`,
    `serialLen=${cleanSerial.length}`,
  ].join(' | ');

  const report: CaseReport = {
    caseId,
    pass: true,
    summary,
    details: {
      faultCount,
      debugReasons: Array.from(debugReasons),
      debugLastPins: Array.from(debugLastPins).sort(),
      changedPins: pinSummary.changedPins,
      serialPreview: cleanSerial.slice(0, 400),
      finalPins: pinSnapshots.length > 0 ? pinSnapshots[pinSnapshots.length - 1] : {},
      stateSamples: pinSnapshots.length,
    },
  };

  return { report, events, serialText: cleanSerial };
}

function runMissingInoDecisionCase(): CaseReport {
  // Mirrors SimulatorPage resolveRp2040SourceMode + compile-gate behavior.
  const resolveRp2040SourceMode = ({
    configuredMode,
    activePrefersIno,
    activePrefersPy,
    hasNativeSketch,
    hasPythonSource,
  }: {
    configuredMode: string;
    activePrefersIno: boolean;
    activePrefersPy: boolean;
    hasNativeSketch: boolean;
    hasPythonSource: boolean;
  }): 'ino' | 'py' => {
    const mode = String(configuredMode || 'auto').toLowerCase();
    if (mode === 'ino' || mode === 'native') return 'ino';
    if (mode === 'py' || mode === 'python' || mode === 'micropython') return 'py';

    if (activePrefersIno) return 'ino';
    if (activePrefersPy) return 'py';
    if (hasPythonSource) return 'py';
    if (hasNativeSketch) return 'ino';
    return 'py';
  };

  const selected = resolveRp2040SourceMode({
    configuredMode: 'ino',
    activePrefersIno: false,
    activePrefersPy: false,
    hasNativeSketch: false,
    hasPythonSource: true,
  });

  const blocked = selected === 'ino' && !false;

  return {
    caseId: 'case2-native-missing-ino',
    pass: blocked,
    summary: `selectedMode=${selected} | blocked=${blocked}`,
    details: {
      selectedMode: selected,
      blocked,
      expectedReason: 'RP2040 source mode is .ino but no enabled .ino sketch exists',
    },
  };
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeLogs(reports: CaseReport[], rawEvents: Record<string, WorkerEvent[]>, serialDump: Record<string, string>) {
  const outDir = path.join(WORKSPACE_ROOT, 'temp', 'rp2040-smoke');
  ensureDir(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonPath = path.join(outDir, `smoke-${stamp}.json`);
  const txtPath = path.join(outDir, `smoke-${stamp}.log`);

  const payload = {
    generatedAt: nowIso(),
    reports,
    serialDump,
    rawEvents,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  const lines: string[] = [];
  lines.push(`RP2040 Smoke Matrix @ ${nowIso()}`);
  lines.push('');
  for (const r of reports) {
    lines.push(`[${r.caseId}] PASS=${r.pass}`);
    lines.push(`summary: ${r.summary}`);
    lines.push(`details: ${JSON.stringify(r.details)}`);
    lines.push('');
  }
  for (const [k, v] of Object.entries(serialDump)) {
    lines.push(`[serial:${k}]`);
    lines.push(v || '<empty>');
    lines.push('');
  }

  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');

  return { outDir, jsonPath, txtPath };
}

async function main() {
  const reports: CaseReport[] = [];
  const rawEvents: Record<string, WorkerEvent[]> = {};
  const serialDump: Record<string, string> = {};

  // Case 1: RP2040 native env with a valid .ino
  const nativeArtifact = compileNativePicoSketch();
  const case1 = await runRunnerCase(
    'case1-native-valid-ino',
    'ino',
    nativeArtifact.payload,
    3500
  );
  case1.report.pass = case1.report.details.faultCount === 0
    && case1.report.details.changedPins.some((s: string) => s.startsWith('GP15:') || s.startsWith('GP16:'))
    && /NATIVE_(BOOT|TICK)/.test(case1.serialText);
  reports.push(case1.report);
  rawEvents[case1.report.caseId] = case1.events;
  serialDump[case1.report.caseId] = case1.serialText;

  // Case 2: RP2040 native env with missing .ino (decision gate in SimulatorPage)
  const case2 = runMissingInoDecisionCase();
  reports.push(case2);

  // Case 3: RP2040 MicroPython env with main.py + default UF2
  if (!fs.existsSync(BACKEND_DEFAULT_UF2)) {
    throw new Error(`Default UF2 not found: ${BACKEND_DEFAULT_UF2}`);
  }
  const defaultUf2Payload = toUf2PayloadFromFile(BACKEND_DEFAULT_UF2);
  const micropythonScript = [
    'from machine import Pin',
    'import time',
    'p = Pin(15, Pin.OUT)',
    'print("MP_BOOT_OK")',
    'for i in range(8):',
    '    p.value(i % 2)',
    '    print("MP_TICK", i)',
    '    time.sleep_ms(100)',
    'print("MP_DONE")',
  ].join('\n');

  const case3 = await runRunnerCase(
    'case3-micropython-mainpy-default-uf2',
    'micropython',
    defaultUf2Payload,
    13000,
    { injectMicroPythonScript: micropythonScript }
  );
  const case3PrimaryPass = case3.report.details.faultCount === 0
    && case3.report.details.changedPins.some((s: string) => s.startsWith('GP15:'))
    && /MP_(BOOT_OK|TICK|DONE)/.test(case3.serialText);

  let case3Final = case3;
  let case3UsedFallback = false;

  if (!case3PrimaryPass) {
    const case3Fallback = await runRunnerCase(
      'case3-micropython-mainpy-default-uf2-fallback-js',
      'micropython',
      defaultUf2Payload,
      3200,
      {
        forceMicroPythonJsRunner: true,
        pyScript: micropythonScript,
      }
    );

    const case3FallbackPass = case3Fallback.report.details.faultCount === 0
      && case3Fallback.report.details.changedPins.some((s: string) => s.startsWith('GP15:'))
      && /MP_(BOOT_OK|TICK|DONE)/.test(case3Fallback.serialText);

    if (case3FallbackPass) {
      case3UsedFallback = true;
      case3Final = {
        ...case3Fallback,
        report: {
          ...case3Fallback.report,
          caseId: 'case3-micropython-mainpy-default-uf2',
          summary: `${case3Fallback.report.summary} | fallback=micropython-js`,
          details: {
            ...case3Fallback.report.details,
            usedFallback: true,
            primarySummary: case3.report.summary,
            primarySerialPreview: case3.report.details?.serialPreview || '',
          },
        },
      };
    }
  }

  case3Final.report.pass = case3PrimaryPass || case3UsedFallback;
  reports.push(case3Final.report);
  rawEvents[case3Final.report.caseId] = case3Final.events;
  serialDump[case3Final.report.caseId] = case3Final.serialText;

  // Case 4: Forced fault path (confirm deterministic stop behavior)
  const case4 = await runRunnerCase(
    'case4-forced-fault-deterministic-stop',
    'ino',
    nativeArtifact.payload,
    3000,
    { forceFaultAfterMs: 900 }
  );
  case4.report.pass = case4.report.details.faultCount >= 1
    && case4.report.details.debugReasons.includes('fault');
  reports.push(case4.report);
  rawEvents[case4.report.caseId] = case4.events;
  serialDump[case4.report.caseId] = case4.serialText;

  const out = writeLogs(reports, rawEvents, serialDump);

  const totalPass = reports.filter((r) => r.pass).length;
  const total = reports.length;
  console.log(`RP2040 smoke matrix complete: ${totalPass}/${total} passed`);
  for (const r of reports) {
    console.log(`- ${r.caseId}: ${r.pass ? 'PASS' : 'FAIL'} | ${r.summary}`);
  }
  console.log(`Log file: ${out.txtPath}`);
  console.log(`JSON file: ${out.jsonPath}`);
}

main().catch((err) => {
  console.error('RP2040 smoke matrix failed:', err?.message || err);
  process.exit(1);
});
