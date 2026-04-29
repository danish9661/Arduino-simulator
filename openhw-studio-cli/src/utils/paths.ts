import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLI_ROOT = path.resolve(__dirname, '..', '..');
export const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '..');
export const FRONTEND_ROOT = path.join(WORKSPACE_ROOT, 'OpenHW-studio-frontend');
export const EMULATOR_ROOT = path.join(WORKSPACE_ROOT, 'openhw-studio-emulator');

// npm scripts can change process.cwd() to the package directory.
// Prefer INIT_CWD when available so relative paths follow where the user ran the command.
const INVOCATION_CWD = process.env.INIT_CWD || process.cwd();

export function resolveWorkspacePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(INVOCATION_CWD, inputPath);
}

export function relToCwd(filePath: string): string {
  return path.relative(INVOCATION_CWD, filePath) || path.basename(filePath);
}
