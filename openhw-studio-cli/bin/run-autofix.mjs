#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: run-autofix.mjs <project.json> [issue.json]');
    process.exit(0);
  }

  const projectFile = path.resolve(args[0]);
  const issueFile = args[1] ? path.resolve(args[1]) : null;

  if (!fs.existsSync(projectFile)) {
    console.error('Project file not found:', projectFile);
    process.exit(2);
  }

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const issue = issueFile && fs.existsSync(issueFile) ? JSON.parse(fs.readFileSync(issueFile, 'utf8')) : { message: 'missing_ground_connection', compIds: [] };

  // Import emulator autofix (resolve relative to repository root regardless of cwd)
  const workspaceRoot = path.resolve(__dirname, '..', '..');
  const indexPath = path.join(workspaceRoot, 'openhw-studio-emulator', 'src', 'circuit-validation', 'index.js');
  const mod = await import(pathToFileURL(indexPath).href);
  const applyCircuitFix = mod.applyCircuitFix;
  if (!applyCircuitFix) {
    console.error('applyCircuitFix not available from emulator');
    process.exit(3);
  }

  const result = applyCircuitFix({ components: project.components || [], connections: (project.connections||[]).map(w=>({ from: String(w.from||'').replace(':','.'), to: String(w.to||'').replace(':','.') })) }, issue, { appliedBy: 'cli' });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err); process.exit(4); });
