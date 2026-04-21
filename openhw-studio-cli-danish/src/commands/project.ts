import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  addComponent,
  addConnection,
  createProject,
  extractProjectFromPng,
  loadProject,
  normalizeProject,
  saveProject,
  setBoardCode,
  summarizeProject,
  validateProject,
} from '../utils/project.js';
import { listKnownComponentTypes } from '../utils/manifests.js';
import { resolveWorkspacePath, relToCwd } from '../utils/paths.js';

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function parseAttrs(attrsJson?: string): Record<string, unknown> {
  if (!attrsJson) return {};
  try {
    const parsed = JSON.parse(attrsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('attrs JSON must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid --attrs-json value: ${(error as Error).message}`);
  }
}

function parseBooleanInput(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text.length) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  throw new Error(`Invalid boolean value: ${String(value)} (expected true/false)`);
}

async function resolveAttrsInput(options: {
  attrsJson?: string;
  attrsFile?: string;
}): Promise<Record<string, unknown>> {
  const hasJson = typeof options.attrsJson === 'string';
  const hasFile = typeof options.attrsFile === 'string';

  if (hasJson && hasFile) {
    throw new Error('Use only one attrs source: --attrs-json or --attrs-file.');
  }

  if (hasFile) {
    const raw = await fs.readFile(resolveWorkspacePath(String(options.attrsFile)), 'utf8');
    return parseAttrs(raw);
  }

  return parseAttrs(options.attrsJson);
}

async function readRawJsonFile(filePath: string): Promise<any> {
  const absolute = resolveWorkspacePath(filePath);
  const raw = await fs.readFile(absolute, 'utf8');
  return JSON.parse(raw);
}

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Project JSON import/export/edit commands');

  project
    .command('init <projectFile>')
    .description('Create a new project JSON file')
    .option('--name <name>', 'Project display name', 'Untitled')
    .option('--board <board>', 'Board kind: arduino_uno|rp2040|esp32|stm32', 'arduino_uno')
    .action(async (projectFile: string, options: { name: string; board: string }) => {
      const projectData = createProject(options.name, options.board);
      await saveProject(projectFile, projectData);
      printJson({
        ok: true,
        action: 'project.init',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        summary: summarizeProject(projectData),
      });
    });

  project
    .command('summary <projectFile>')
    .description('Print project summary')
    .action(async (projectFile: string) => {
      const projectData = await loadProject(projectFile);
      printJson({ ok: true, action: 'project.summary', summary: summarizeProject(projectData) });
    });

  project
    .command('import-png <pngFile>')
    .description('Import OPENHW metadata from PNG and write normalized project JSON')
    .requiredOption('-o, --output <projectFile>', 'Output project file path')
    .action(async (pngFile: string, options: { output: string }) => {
      const projectData = await extractProjectFromPng(pngFile);
      await saveProject(options.output, projectData);
      printJson({
        ok: true,
        action: 'project.import-png',
        input: relToCwd(resolveWorkspacePath(pngFile)),
        output: relToCwd(resolveWorkspacePath(options.output)),
        summary: summarizeProject(projectData),
      });
    });

  project
    .command('import-json <inputFile>')
    .description('Normalize any compatible project JSON and write canonical schema output')
    .requiredOption('-o, --output <projectFile>', 'Output project file path')
    .action(async (inputFile: string, options: { output: string }) => {
      const raw = await readRawJsonFile(inputFile);
      const projectData = normalizeProject(raw);
      await saveProject(options.output, projectData);
      printJson({
        ok: true,
        action: 'project.import-json',
        input: relToCwd(resolveWorkspacePath(inputFile)),
        output: relToCwd(resolveWorkspacePath(options.output)),
        summary: summarizeProject(projectData),
      });
    });

  project
    .command('export-json <projectFile>')
    .description('Export normalized project JSON to file or stdout')
    .option('-o, --output <outputFile>', 'Output file path (default: stdout)')
    .action(async (projectFile: string, options: { output?: string }) => {
      const projectData = await loadProject(projectFile);
      if (options.output) {
        await saveProject(options.output, projectData);
        printJson({
          ok: true,
          action: 'project.export-json',
          input: relToCwd(resolveWorkspacePath(projectFile)),
          output: relToCwd(resolveWorkspacePath(options.output)),
          summary: summarizeProject(projectData),
        });
        return;
      }

      printJson(projectData);
    });

  project
    .command('validate <projectFile>')
    .description('Validate project schema and references')
    .action(async (projectFile: string) => {
      const projectData = await loadProject(projectFile);
      const report = await validateProject(projectData);
      printJson({
        ok: report.valid,
        action: 'project.validate',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        ...report,
      });
      if (!report.valid) {
        process.exitCode = 1;
      }
    });

  project
    .command('add-component <projectFile>')
    .description('Add a component to the project')
    .requiredOption('--type <type>', 'Component type (manifest type)')
    .option('--id <id>', 'Component id (auto-generated when omitted)')
    .option('--x <x>', 'Canvas x coordinate')
    .option('--y <y>', 'Canvas y coordinate')
    .option('--label <label>', 'Display label')
    .option('--attrs-json <json>', 'Component attrs object JSON')
    .option('--attrs-file <file>', 'Path to JSON file containing attrs object')
    .option('-o, --output <outputFile>', 'Write to different output file')
    .action(async (projectFile: string, options: any) => {
      const projectData = await loadProject(projectFile);
      const attrs = await resolveAttrsInput({
        attrsJson: options.attrsJson,
        attrsFile: options.attrsFile,
      });
      const entry = await addComponent(projectData, {
        type: options.type,
        id: options.id,
        x: options.x !== undefined ? Number(options.x) : undefined,
        y: options.y !== undefined ? Number(options.y) : undefined,
        label: options.label,
        attrs,
      });

      const target = options.output || projectFile;
      await saveProject(target, projectData);
      printJson({
        ok: true,
        action: 'project.add-component',
        file: relToCwd(resolveWorkspacePath(target)),
        component: entry,
      });
    });

  project
    .command('connect <projectFile>')
    .description('Connect two endpoints using <componentId>:<pinId> syntax')
    .requiredOption('--from <endpoint>', 'Source endpoint')
    .requiredOption('--to <endpoint>', 'Target endpoint')
    .option('--id <wireId>', 'Wire id (auto-generated when omitted)')
    .option('--color <color>', 'Wire color', '#e74c3c')
    .option('-o, --output <outputFile>', 'Write to different output file')
    .action(async (projectFile: string, options: any) => {
      const projectData = await loadProject(projectFile);
      const wire = await addConnection(projectData, {
        from: options.from,
        to: options.to,
        id: options.id,
        color: options.color,
      });

      const target = options.output || projectFile;
      await saveProject(target, projectData);
      printJson({
        ok: true,
        action: 'project.connect',
        file: relToCwd(resolveWorkspacePath(target)),
        wire,
      });
    });

  project
    .command('set-code <projectFile>')
    .description('Set board source code content from string or file')
    .requiredOption('--board-id <boardId>', 'Board component id')
    .option('--file <projectFilePath>', 'Project file path to update, e.g. project/board1/main.py')
    .option('--code <code>', 'Inline code string')
    .option('--code-file <codeFile>', 'Read code from file path')
    .option('-o, --output <outputFile>', 'Write to different output file')
    .action(async (projectFile: string, options: any) => {
      const hasInline = typeof options.code === 'string';
      const hasCodeFile = typeof options.codeFile === 'string';
      if (!hasInline && !hasCodeFile) {
        throw new Error('Provide either --code or --code-file.');
      }
      if (hasInline && hasCodeFile) {
        throw new Error('Use only one source: --code or --code-file.');
      }

      const codeText = hasInline
        ? String(options.code)
        : await fs.readFile(resolveWorkspacePath(String(options.codeFile)), 'utf8');

      const projectData = await loadProject(projectFile);
      const file = setBoardCode(projectData, {
        boardId: options.boardId,
        code: codeText,
        filePath: options.file,
      });

      const target = options.output || projectFile;
      await saveProject(target, projectData);
      printJson({
        ok: true,
        action: 'project.set-code',
        file: relToCwd(resolveWorkspacePath(target)),
        updated: { id: file.id, path: file.path, boardId: file.boardId },
      });
    });

  project
    .command('set-blockly <projectFile>')
    .description('Set Blockly XML/generated code metadata for the project')
    .option('--xml <xml>', 'Inline Blockly XML payload')
    .option('--xml-file <file>', 'Read Blockly XML from file')
    .option('--generated-code <code>', 'Inline generated code from block workflow')
    .option('--generated-code-file <file>', 'Read generated code from file')
    .option('--use-blockly-code <boolean>', 'Whether generated Blockly code should be preferred')
    .option('-o, --output <outputFile>', 'Write to different output file')
    .action(async (projectFile: string, options: any) => {
      const hasXmlInline = typeof options.xml === 'string';
      const hasXmlFile = typeof options.xmlFile === 'string';
      if (hasXmlInline && hasXmlFile) {
        throw new Error('Use only one XML source: --xml or --xml-file.');
      }

      const hasCodeInline = typeof options.generatedCode === 'string';
      const hasCodeFile = typeof options.generatedCodeFile === 'string';
      if (hasCodeInline && hasCodeFile) {
        throw new Error('Use only one generated code source: --generated-code or --generated-code-file.');
      }

      const projectData = await loadProject(projectFile);

      if (hasXmlInline || hasXmlFile) {
        projectData.blocklyXml = hasXmlInline
          ? String(options.xml)
          : await fs.readFile(resolveWorkspacePath(String(options.xmlFile)), 'utf8');
      }

      if (hasCodeInline || hasCodeFile) {
        projectData.blocklyGeneratedCode = hasCodeInline
          ? String(options.generatedCode)
          : await fs.readFile(resolveWorkspacePath(String(options.generatedCodeFile)), 'utf8');
      }

      if (options.useBlocklyCode !== undefined) {
        projectData.useBlocklyCode = parseBooleanInput(options.useBlocklyCode, !!projectData.useBlocklyCode);
      }

      const target = options.output || projectFile;
      await saveProject(target, projectData);
      printJson({
        ok: true,
        action: 'project.set-blockly',
        file: relToCwd(resolveWorkspacePath(target)),
        blockly: {
          useBlocklyCode: !!projectData.useBlocklyCode,
          xmlLength: String(projectData.blocklyXml || '').length,
          generatedCodeLength: String(projectData.blocklyGeneratedCode || '').length,
        },
      });
    });

  project
    .command('block-summary <projectFile>')
    .description('Show block-coding metadata summary')
    .action(async (projectFile: string) => {
      const projectData = await loadProject(projectFile);
      printJson({
        ok: true,
        action: 'project.block-summary',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        blockly: {
          useBlocklyCode: !!projectData.useBlocklyCode,
          hasXml: !!String(projectData.blocklyXml || '').trim(),
          hasGeneratedCode: !!String(projectData.blocklyGeneratedCode || '').trim(),
          xmlLength: String(projectData.blocklyXml || '').length,
          generatedCodeLength: String(projectData.blocklyGeneratedCode || '').length,
        },
      });
    });

  project
    .command('component-types')
    .description('List known component manifest types from emulator package')
    .option('--json', 'Print JSON array output')
    .action(async (options: { json?: boolean }) => {
      const types = await listKnownComponentTypes();
      if (options.json) {
        printJson(types);
        return;
      }
      for (const t of types) {
        process.stdout.write(`${t}\n`);
      }
    });

  project
    .command('set-library-file <projectFile>')
    .description('Set project/library.txt content from a text file')
    .requiredOption('--input <libraryFile>', 'Path to library list text file (one lib per line)')
    .option('-o, --output <outputFile>', 'Write to different output file')
    .action(async (projectFile: string, options: { input: string; output?: string }) => {
      const projectData = await loadProject(projectFile);
      const text = await fs.readFile(resolveWorkspacePath(options.input), 'utf8');
      const libraryPath = 'project/library.txt';
      let libraryFile = projectData.projectFiles.find((f) => f.path === libraryPath);
      if (!libraryFile) {
        libraryFile = {
          id: libraryPath,
          path: libraryPath,
          name: path.basename(libraryPath),
          kind: 'root',
          content: '',
          dirty: false,
        };
        projectData.projectFiles.push(libraryFile);
      }
      libraryFile.content = text;
      libraryFile.dirty = false;

      const target = options.output || projectFile;
      await saveProject(target, projectData);
      printJson({
        ok: true,
        action: 'project.set-library-file',
        file: relToCwd(resolveWorkspacePath(target)),
      });
    });
}
