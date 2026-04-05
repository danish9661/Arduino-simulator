import { Command, CommanderError } from 'commander';
import { registerLibCommands } from './commands/lib.js';
import { registerProjectCommands } from './commands/project.js';
import { registerReplCommand } from './commands/repl.js';
import { registerSerialCommands } from './commands/serial.js';
import { registerSimCommands } from './commands/sim.js';
import { DEFAULT_BACKEND_URL } from './utils/backend.js';

interface CreateProgramOptions {
  enableRepl: boolean;
  executeTokens: (tokens: string[]) => Promise<number>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function createProgram(options: CreateProgramOptions): Command {
  const program = new Command();

  program
    .name('openhw')
    .description('OpenHW terminal CLI for project editing, simulation, serial, and libraries')
    .version('0.1.0')
    .showHelpAfterError()
    .option('--backend-url <url>', 'Backend API base URL', DEFAULT_BACKEND_URL);

  const getBackendUrl = (): string => {
    const opts = program.opts();
    const value = String(opts.backendUrl || DEFAULT_BACKEND_URL).trim();
    return value.replace(/\/+$/, '') || DEFAULT_BACKEND_URL;
  };

  registerProjectCommands(program);
  registerSimCommands(program, getBackendUrl);
  registerSerialCommands(program, getBackendUrl);
  registerLibCommands(program, getBackendUrl);

  if (options.enableRepl) {
    registerReplCommand(program, options.executeTokens);
  }

  return program;
}

export async function runCliArgv(
  argv: string[],
  config: { enableRepl?: boolean } = {}
): Promise<number> {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  const codeFromParse = await (async () => {
    try {
      const program = createProgram({
        enableRepl: config.enableRepl !== false,
        executeTokens: async (tokens: string[]) => {
          return runCliArgv(['node', 'openhw', ...tokens], { enableRepl: false });
        },
      });

      program.exitOverride();
      await program.parseAsync(argv);
      return 0;
    } catch (error) {
      if (error instanceof CommanderError) {
        if (error.code === 'commander.helpDisplayed') {
          return 0;
        }
        return Number.isFinite(Number(error.exitCode)) ? Number(error.exitCode) : 1;
      }

      process.stderr.write(`${getErrorMessage(error)}\n`);
      return 1;
    }
  })();

  const codeFromCommand = Number.isFinite(Number(process.exitCode)) ? Number(process.exitCode) : 0;
  const finalCode = codeFromParse !== 0 ? codeFromParse : codeFromCommand;

  process.exitCode = previousExitCode;
  return finalCode;
}
