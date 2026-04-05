import { Command } from 'commander';
import { SerialPort } from 'serialport';
import { runSimulationOnce } from '../sim/session.js';
import { listBackendPorts } from '../utils/backend.js';
import { loadProject } from '../utils/project.js';
import { BOARD_DEFAULT_BAUD, normalizeBoardKind } from '../utils/boards.js';
import { relToCwd, resolveWorkspacePath } from '../utils/paths.js';

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function portPathOf(port: any): string {
  return String(port?.path || port?.comName || port?.name || port?.port || '').trim();
}

function portLabel(port: any): string {
  const pathName = portPathOf(port);
  const meta = [
    port?.friendlyName,
    port?.manufacturer,
    port?.vendorId,
    port?.productId,
    port?.pnpId,
  ]
    .filter(Boolean)
    .join(' | ');
  return meta ? `${pathName} (${meta})` : pathName;
}

function findPortByHint(ports: any[], hint?: string): any | null {
  if (!hint) return null;
  const needle = String(hint).toLowerCase();
  for (const p of ports) {
    const hay = [
      p?.path,
      p?.comName,
      p?.name,
      p?.friendlyName,
      p?.manufacturer,
      p?.serialNumber,
      p?.pnpId,
      p?.vendorId,
      p?.productId,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase())
      .join(' ');
    if (hay.includes(needle)) {
      return p;
    }
  }
  return null;
}

async function resolveHardwarePort(
  backendUrl: string,
  options: { port?: string; board?: string; showAll?: boolean }
): Promise<{ portPath: string; ports: any[] }> {
  const ports = await listBackendPorts(backendUrl, !!options.showAll);

  if (options.port) {
    const exact = ports.find((p) => portPathOf(p).toLowerCase() === String(options.port).toLowerCase());
    if (!exact) {
      throw new Error(`Requested --port not found: ${options.port}`);
    }
    return { portPath: portPathOf(exact), ports };
  }

  const hinted = findPortByHint(ports, options.board);
  if (hinted) {
    return { portPath: portPathOf(hinted), ports };
  }

  if (ports.length === 1) {
    return { portPath: portPathOf(ports[0]), ports };
  }

  const listed = ports.map(portLabel).join(', ');
  throw new Error(
    ports.length
      ? `Multiple ports found. Use --port or --board. Available: ${listed}`
      : 'No serial ports detected from backend.'
  );
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

async function monitorHardwareSerial(
  portPath: string,
  baudRate: number,
  options: { stdin: boolean; durationMs: number }
): Promise<void> {
  const port = new SerialPort({ path: portPath, baudRate, autoOpen: true });
  process.stderr.write(`[serial] monitoring ${portPath} @ ${baudRate} baud\n`);
  if (options.stdin) {
    process.stderr.write('[serial] stdin forwarding enabled (Ctrl+C to stop)\n');
  }

  let done = false;
  let timeout: NodeJS.Timeout | undefined;
  let stdinHandler: ((chunk: string) => void) | undefined;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      if (done) return;
      done = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      process.off('SIGINT', onSigint);

      if (stdinHandler) {
        process.stdin.off('data', stdinHandler);
      }

      if (port.isOpen) {
        port.close(() => resolve());
      } else {
        resolve();
      }
    };

    const onSigint = () => {
      cleanup();
    };

    port.on('data', (data: Buffer) => {
      process.stdout.write(data.toString('utf8'));
    });

    port.on('error', (err: Error) => {
      reject(err);
    });

    process.on('SIGINT', onSigint);

    if (options.stdin) {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      stdinHandler = (chunk: string) => {
        if (!port.isOpen) return;
        port.write(chunk);
      };
      process.stdin.on('data', stdinHandler);
    }

    if (options.durationMs > 0) {
      timeout = setTimeout(() => cleanup(), options.durationMs);
      timeout.unref();
    }
  });
}

export function registerSerialCommands(
  program: Command,
  getBackendUrl: () => string
): void {
  const serial = program.command('serial').description('Serial monitor commands (hardware + simulation)');

  serial
    .command('ports')
    .description('List serial ports detected by backend')
    .option('--show-all', 'Include all ports (not only known boards)')
    .option('--json', 'Print JSON output')
    .action(async (options: { showAll?: boolean; json?: boolean }) => {
      const ports = await listBackendPorts(getBackendUrl(), !!options.showAll);
      if (options.json) {
        printJson(ports);
        return;
      }

      if (!ports.length) {
        process.stdout.write('No serial ports detected.\n');
        return;
      }

      for (const p of ports) {
        process.stdout.write(`${portLabel(p)}\n`);
      }
    });

  serial
    .command('monitor')
    .description('Hardware serial monitor (reads + writes via stdin)')
    .option('--port <port>', 'Exact serial port path, e.g. COM7')
    .option('--board <hint>', 'Board hint to auto-select port (name/manufacturer/id match)')
    .option('--baud <baud>', 'Baud rate', '115200')
    .option('--show-all', 'Include all ports when discovering')
    .option('--duration-ms <ms>', 'Auto-stop after duration (0 = Ctrl+C)', '0')
    .option('--no-stdin', 'Disable stdin -> serial forwarding')
    .action(async (options: any) => {
      const backendUrl = getBackendUrl();
      const { portPath } = await resolveHardwarePort(backendUrl, {
        port: options.port,
        board: options.board,
        showAll: !!options.showAll,
      });

      const baudRate = parsePositiveInt(options.baud, 115200);
      const durationMs = parsePositiveInt(options.durationMs, 0);
      await monitorHardwareSerial(portPath, baudRate, {
        stdin: options.stdin !== false,
        durationMs,
      });
    });

  serial
    .command('sim-monitor <projectFile>')
    .description('Run simulated board serial monitor (stdin <-> simulated serial)')
    .option('--board-id <id>', 'Board component id to run')
    .option('--debug <mode>', 'Debug mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--duration-ms <ms>', 'Auto-stop after duration (0 = Ctrl+C)', '0')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const boardType = options.boardId
        ? project.components.find((c) => c.id === options.boardId)?.type || project.board
        : project.board;

      const debugMode = String(options.debug || 'off').toLowerCase();
      if (!['off', 'text', 'json'].includes(debugMode)) {
        throw new Error('Invalid --debug mode. Expected off, text, or json.');
      }

      const kind = normalizeBoardKind(boardType);
      const result = await runSimulationOnce(project, {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        durationMs: parsePositiveInt(options.durationMs, 0),
        debugMode: debugMode as 'off' | 'text' | 'json',
        baudRate: parsePositiveInt(options.baud, BOARD_DEFAULT_BAUD[kind] || 9600),
        stdinSerial: true,
      });

      printJson({
        ok: true,
        action: 'serial.sim-monitor',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        result,
      });
    });
}
