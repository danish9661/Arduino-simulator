import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(cliRoot, '..');

function tsxCommand() {
  return process.platform === 'win32'
    ? path.join(cliRoot, 'node_modules', '.bin', 'tsx.cmd')
    : path.join(cliRoot, 'node_modules', '.bin', 'tsx');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJsonOutput(output, context) {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`${context} did not return valid JSON. Output: ${output}\n${String(error)}`);
  }
}

async function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxCommand(), ['src/cli.ts', ...args], {
      cwd: cliRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`CLI command failed (exit=${code}): ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const tempDir = path.join(workspaceRoot, 'temp');
  await fs.mkdir(tempDir, { recursive: true });

  const projectPath = path.join(tempDir, `block-cli-${Date.now()}.json`);
  const xmlPath = path.join(tempDir, `block-cli-${Date.now()}-workspace.xml`);

  const blockXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="controls_if" x="12" y="24"></block></xml>';
  const generatedCode = 'void setup(){}\nvoid loop(){}\n';

  await fs.writeFile(xmlPath, blockXml, 'utf8');

  await runCli(['project', 'init', projectPath, '--name', 'block-cli', '--board', 'rp2040']);

  const setOutput = await runCli([
    'project',
    'set-blockly',
    projectPath,
    '--xml-file',
    xmlPath,
    '--generated-code',
    generatedCode,
    '--use-blockly-code',
    'true',
  ]);

  const setPayload = parseJsonOutput(setOutput.stdout, 'project set-blockly');
  assert(setPayload.ok === true, 'project set-blockly should return ok=true');
  assert(setPayload.blockly?.useBlocklyCode === true, 'useBlocklyCode should be true after set-blockly');
  assert(Number(setPayload.blockly?.xmlLength || 0) > 0, 'xmlLength should be > 0');

  const summaryOutput = await runCli(['project', 'block-summary', projectPath]);
  const summaryPayload = parseJsonOutput(summaryOutput.stdout, 'project block-summary');
  assert(summaryPayload.ok === true, 'project block-summary should return ok=true');
  assert(summaryPayload.blockly?.hasXml === true, 'block-summary should report hasXml=true');
  assert(summaryPayload.blockly?.hasGeneratedCode === true, 'block-summary should report hasGeneratedCode=true');

  const exportOutput = await runCli(['project', 'export-json', projectPath]);
  const projectPayload = parseJsonOutput(exportOutput.stdout, 'project export-json');

  assert(projectPayload.blocklyXml === blockXml, 'exported project should preserve blocklyXml');
  assert(projectPayload.blocklyGeneratedCode === generatedCode, 'exported project should preserve blocklyGeneratedCode');
  assert(projectPayload.useBlocklyCode === true, 'exported project should preserve useBlocklyCode=true');

  console.log('[cli-block-coding] PASS');
}

main().catch((error) => {
  console.error(`[cli-block-coding] FAIL ${String(error?.message || error)}`);
  process.exit(1);
});
