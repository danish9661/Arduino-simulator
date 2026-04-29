import { Command } from 'commander';
import {
  installLibrary,
  listLibraries,
  searchLibraries,
  uninstallLibrary,
} from '../utils/backend.js';
import { loadProject } from '../utils/project.js';

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function normalizeLibName(entry: any): string {
  return String(entry?.name || entry?.library?.name || entry?.label || '').trim();
}

function parseLibraryText(content: string): string[] {
  const out: string[] = [];
  for (const rawLine of String(content || '').split(/\r?\n/g)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // Accept a simple "Name@Version" form while keeping backend install input stable.
    const [name] = trimmed.split('@');
    if (name && name.trim()) {
      out.push(name.trim());
    }
  }
  return Array.from(new Set(out));
}

async function readProjectLibraryNames(projectFile: string): Promise<string[]> {
  const project = await loadProject(projectFile);
  const file = project.projectFiles.find((f) => f.path === 'project/library.txt');
  const content = file?.content || '';
  return parseLibraryText(content);
}

export function registerLibCommands(
  program: Command,
  getBackendUrl: () => string
): void {
  const lib = program.command('lib').description('Library management through backend API');

  lib
    .command('list')
    .description('List installed libraries')
    .option('--json', 'Print JSON output')
    .action(async (options: { json?: boolean }) => {
      const items = await listLibraries(getBackendUrl());
      if (options.json) {
        printJson(items);
        return;
      }

      if (!items.length) {
        process.stdout.write('No installed libraries found.\n');
        return;
      }

      for (const item of items) {
        const name = normalizeLibName(item) || JSON.stringify(item);
        process.stdout.write(`${name}\n`);
      }
    });

  lib
    .command('search <query>')
    .description('Search available libraries')
    .option('--json', 'Print JSON output')
    .action(async (query: string, options: { json?: boolean }) => {
      const items = await searchLibraries(getBackendUrl(), query);
      if (options.json) {
        printJson(items);
        return;
      }

      if (!items.length) {
        process.stdout.write('No matching libraries found.\n');
        return;
      }

      for (const item of items) {
        const name = normalizeLibName(item) || JSON.stringify(item);
        process.stdout.write(`${name}\n`);
      }
    });

  lib
    .command('install <name>')
    .description('Install one library by name')
    .action(async (name: string) => {
      const result = await installLibrary(getBackendUrl(), name);
      printJson({ ok: true, action: 'lib.install', name, result });
    });

  lib
    .command('uninstall <name>')
    .description('Uninstall one library by name')
    .action(async (name: string) => {
      const result = await uninstallLibrary(getBackendUrl(), name);
      printJson({ ok: true, action: 'lib.uninstall', name, result });
    });

  lib
    .command('sync-project <projectFile>')
    .description('Install all libraries listed in project/library.txt')
    .option('--dry-run', 'Show what would be installed without installing')
    .action(async (projectFile: string, options: { dryRun?: boolean }) => {
      const names = await readProjectLibraryNames(projectFile);
      if (!names.length) {
        printJson({
          ok: true,
          action: 'lib.sync-project',
          dryRun: !!options.dryRun,
          message: 'No libraries listed in project/library.txt',
          installed: [],
        });
        return;
      }

      if (options.dryRun) {
        printJson({
          ok: true,
          action: 'lib.sync-project',
          dryRun: true,
          libraries: names,
        });
        return;
      }

      const installed: Array<{ name: string; ok: boolean; error?: string; result?: any }> = [];
      for (const name of names) {
        try {
          const result = await installLibrary(getBackendUrl(), name);
          installed.push({ name, ok: true, result });
        } catch (error) {
          installed.push({ name, ok: false, error: (error as Error).message });
        }
      }

      const failed = installed.filter((x) => !x.ok);
      printJson({
        ok: failed.length === 0,
        action: 'lib.sync-project',
        dryRun: false,
        installed,
      });
      if (failed.length > 0) {
        process.exitCode = 1;
      }
    });
}
