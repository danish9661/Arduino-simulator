import { Command } from 'commander';
import readline from 'node:readline/promises';

type ExecuteTokens = (tokens: string[]) => Promise<number>;

function splitArgs(line: string): string[] {
  const input = String(line || '');
  const out: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    out.push(current);
  }

  return out;
}

function printReplHelp(): void {
  process.stdout.write('REPL commands:\n');
  process.stdout.write('  help                 Show this help\n');
  process.stdout.write('  exit | quit          Leave REPL\n');
  process.stdout.write('  <any cli command>    Example: project summary my-project.json\n');
  process.stdout.write('\n');
}

export function registerReplCommand(program: Command, executeTokens: ExecuteTokens): void {
  program
    .command('repl')
    .description('Interactive shell for openhw-cli commands')
    .action(async () => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      process.stdout.write('OpenHW CLI REPL started. Type "help" for commands.\n');

      while (true) {
        const line = await rl.question('openhw> ').catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (/readline was closed/i.test(message)) {
            return null;
          }
          throw error;
        });
        if (line === null) {
          break;
        }
        const trimmed = String(line || '').trim();
        if (!trimmed) {
          continue;
        }

        if (trimmed === 'exit' || trimmed === 'quit') {
          break;
        }

        if (trimmed === 'help') {
          printReplHelp();
          continue;
        }

        const tokens = splitArgs(trimmed);
        try {
          const code = await executeTokens(tokens);
          if (code !== 0) {
            process.stderr.write(`[exit ${code}]\n`);
          }
        } catch (error) {
          process.stderr.write(`${(error as Error).message}\n`);
        }
      }

      rl.close();
    });
}
