#!/usr/bin/env node
import { runCliArgv } from './program.js';

async function main(): Promise<void> {
  const code = await runCliArgv(process.argv, { enableRepl: true });
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
