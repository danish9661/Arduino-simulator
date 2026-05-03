#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`
OpenHW Studio Circuit Auto-Fix CLI

Usage: run-autofix.mjs <project.json> [issue.json] [options]

Arguments:
  <project.json>     Path to project JSON file (required)
  [issue.json]       Path to issue JSON file (optional, defaults to missing_ground_connection)

Options:
  --json             Output result as JSON only (no human-readable logs)
  --verbose          Show detailed error messages and stack traces
  --help             Show this help message
  --format <fmt>     Output format: 'json', 'text', or 'compact' (default: text)

Examples:
  node run-autofix.mjs circuit.json
  node run-autofix.mjs circuit.json issue.json --json
  node run-autofix.mjs circuit.json --verbose --format json
  node run-autofix.mjs --help
  `);
}

function logMessage(msg, opts = {}) {
  const { quiet = false, verbose = false, level = 'info' } = opts;
  if (quiet) return;
  
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const prefix = `[${timestamp}]`;
  
  switch (level) {
    case 'error':
      console.error(`${prefix} ✗ ERROR: ${msg}`);
      break;
    case 'warn':
      console.warn(`${prefix} ⚠ WARNING: ${msg}`);
      break;
    case 'success':
      console.log(`${prefix} ✓ ${msg}`);
      break;
    case 'info':
    default:
      if (verbose) console.log(`${prefix} ℹ ${msg}`);
      else console.log(msg);
      break;
  }
}

function formatResult(result, format = 'text') {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  
  if (format === 'compact') {
    return JSON.stringify(result);
  }
  
  // Human-readable text format
  let output = '';
  if (result.applied) {
    output += `✓ Fix Applied Successfully\n`;
    if (result.appliedFixes && result.appliedFixes.length > 0) {
      output += `\n📋 Applied ${result.appliedFixes.length} fix(es):\n`;
      result.appliedFixes.forEach((fix, idx) => {
        output += `  ${idx + 1}. ${fix.pattern} (confidence: ${(fix.confidence * 100).toFixed(0)}%)\n`;
        if (fix.description) output += `     ${fix.description}\n`;
      });
    }
    if (result.metadata && result.metadata.fixedErrors && result.metadata.fixedErrors.length > 0) {
      output += `\n🔧 Fixed issues:\n`;
      result.metadata.fixedErrors.forEach(err => {
        output += `  • ${err}\n`;
      });
    }
    if (result.metadata && result.metadata.detectedNewIssues && result.metadata.detectedNewIssues.length > 0) {
      output += `\n⚠ New issues detected:\n`;
      result.metadata.detectedNewIssues.forEach(issue => {
        output += `  • ${issue}\n`;
      });
    }
  } else {
    output += `✗ Fix Not Applied\n`;
    if (result.reason) {
      output += `  Reason: ${result.reason}\n`;
    }
  }
  
  if (result.components) {
    output += `\n📦 Components: ${result.components.length}\n`;
  }
  if (result.connections) {
    output += `🔗 Connections: ${result.connections.length}\n`;
  }
  
  return output;
}

async function main() {
  const argv = process.argv.slice(2);
  
  // Parse arguments and options
  let projectFile = null;
  let issueFile = null;
  let jsonOnly = false;
  let verbose = false;
  let format = 'text';
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--json') {
      jsonOnly = true;
      format = 'json';
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--format') {
      format = argv[++i] || 'text';
    } else if (!arg.startsWith('--') && !projectFile) {
      projectFile = arg;
    } else if (!arg.startsWith('--') && !issueFile) {
      issueFile = arg;
    }
  }
  
  const quiet = jsonOnly;
  
  try {
    if (!projectFile) {
      logMessage('Missing required argument: <project.json>', { quiet, level: 'error' });
      printHelp();
      process.exit(1);
    }

    const projectPath = path.resolve(projectFile);
    const issuePath = issueFile ? path.resolve(issueFile) : null;

    if (!fs.existsSync(projectPath)) {
      logMessage(`Project file not found: ${projectPath}`, { quiet, level: 'error' });
      process.exit(2);
    }

    if (verbose) logMessage(`Loading project from: ${projectPath}`, { quiet });
    const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    
    let issue = { message: 'missing_ground_connection', compIds: [] };
    if (issuePath && fs.existsSync(issuePath)) {
      if (verbose) logMessage(`Loading issue from: ${issuePath}`, { quiet });
      issue = JSON.parse(fs.readFileSync(issuePath, 'utf8'));
    } else if (issuePath && !fs.existsSync(issuePath)) {
      logMessage(`Issue file not found: ${issuePath}. Using default issue.`, { quiet, level: 'warn' });
    }

    // Import emulator autofix (resolve relative to repository root)
    const workspaceRoot = path.resolve(__dirname, '..', '..');
    const indexPath = path.join(workspaceRoot, 'openhw-studio-emulator', 'src', 'circuit-validation', 'index.js');
    
    if (verbose) logMessage(`Importing autofix engine from: ${indexPath}`, { quiet });
    
    const mod = await import(pathToFileURL(indexPath).href);
    const applyCircuitFix = mod.applyCircuitFix;
    
    if (!applyCircuitFix) {
      logMessage('applyCircuitFix not available from emulator module', { quiet, level: 'error' });
      process.exit(3);
    }

    if (verbose) logMessage(`Applying fix for issue: ${issue.message}`, { quiet });
    
    const result = applyCircuitFix(
      {
        components: projectData.components || [],
        connections: (projectData.connections || []).map(w => ({
          from: String(w.from || '').replace(':', '.'),
          to: String(w.to || '').replace(':', '.')
        }))
      },
      issue,
      { appliedBy: 'cli', verbose, quiet: jsonOnly }
    );

    if (format === 'json' || jsonOnly) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const formatted = formatResult(result, format);
      console.log(formatted);
    }

    process.exit(0);
  } catch (err) {
    const errorMsg = err.message || String(err);
    logMessage(`Error: ${errorMsg}`, { quiet, level: 'error' });
    
    if (verbose) {
      logMessage(`Stack trace:\n${err.stack}`, { quiet, level: 'error' });
    }
    
    if (jsonOnly) {
      console.log(JSON.stringify({
        applied: false,
        reason: 'Error during autofix: ' + errorMsg,
        error: verbose ? err.stack : undefined
      }, null, 2));
    }
    
    process.exit(4);
  }
}

main();
