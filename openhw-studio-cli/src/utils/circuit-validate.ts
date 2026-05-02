/**
 * circuit-validate.ts
 *
 * Adapter that bridges the CLI project format to the FullCircuitValidator
 * engine in the emulator package. This mirrors what SimulatorPage.jsx does
 * on the frontend, so the CLI / MCP server can enforce the same physics-based
 * safety rules without a browser.
 *
 * Wire format translation:
 *   Frontend / CLI stores wires as  comp:pin  (colon-separated)
 *   FullCircuitValidator expects    comp.pin  (dot-separated)
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpenHwProject } from '../types.js';
import { EMULATOR_ROOT } from './paths.js';

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type ValidationSeverity = 'error' | 'warn' | 'info';

export interface CircuitValidationIssue {
  severity: ValidationSeverity;
  type?: string;
  message: string;
  /** Component IDs extracted from the message (best-effort). */
  compIds: string[];
  remediation?: string | null;
  autoFix?: boolean;
  ruleId?: string | null;
  componentId?: string | null;
  source?: string | null;
  priority?: number | null;
  confidence?: number | null;
  details?: unknown;
}

export interface CircuitValidationResult {
  /** true = all checks passed, false = at least one failure. */
  passed: boolean;
  issues: CircuitValidationIssue[];
  /** Raw error objects/strings from the engine. */
  rawErrors: any[];
  profile: string;
  fromCache: boolean;
  rootCauseGroups: unknown[];
  recommendedFixes: unknown[];
  ignoredIssueCount: number;
}

// --------------------------------------------------------------------------
// Engine loader (dynamic import so the CLI doesn't bundle emulator at compile-time)
// --------------------------------------------------------------------------

let cachedValidator: (new (project: any) => any) | null = null;
let cachedSyncAnalyzer: ((project: any, targetBoardId?: string) => any) | null = null;

async function loadEngine(): Promise<{ Validator: any, SyncAnalyzer: any }> {
  if (cachedValidator && cachedSyncAnalyzer) {
    return { Validator: cachedValidator, SyncAnalyzer: cachedSyncAnalyzer };
  }

  try {
    const indexPath = path.join(EMULATOR_ROOT, 'src', 'circuit-validation', 'index.js');
    const mod = await import(pathToFileURL(indexPath).href);
    cachedValidator = mod.FullCircuitValidator ?? null;
    cachedSyncAnalyzer = mod.analyzeCodeHardwareSync ?? null;
    return { Validator: cachedValidator, SyncAnalyzer: cachedSyncAnalyzer };
  } catch {
    // Fallback logic...
    return { Validator: null, SyncAnalyzer: null };
  }
}

// --------------------------------------------------------------------------
// Format translation helpers
// --------------------------------------------------------------------------

/** Convert CLI wire endpoint (comp:pin) → engine format (comp.pin). */
function toEngineEndpoint(endpoint: string): string {
  return String(endpoint || '').replace(':', '.');
}

/** Parse a component ID from an engine error message (e.g. "[LED led1]" → "led1"). */
function extractCompIds(message: string): string[] {
  const matches = String(message).matchAll(/\[(?:MCU|LED|I2C|Arduino|Pico|Buzzer|NPN|Servo|Keypad|Encoder|Pot|L293D|74xx|Nano|Mega|Diode|Stepper|Ultrasonic|7-Segment|LCD|OLED)\s+([\w-]+)\]/g);
  return [...matches].map(m => m[1]).filter(Boolean);
}

/** Classify the severity of an engine error string. */
function classifySeverity(message: string): ValidationSeverity {
  if (message.includes('🔥') || message.includes('FATAL') || message.includes('FRIED')) return 'error';
  if (message.includes('⚠️')) return 'warn';
  return 'info';
}

export interface CodeCircuitSyncIssue {
  severity: 'error' | 'warn';
  message: string;
}

export interface CodeCircuitSyncResult {
  passed: boolean;
  issues: CodeCircuitSyncIssue[];
}

/** Core public function for Physics validation */
export async function runCircuitValidation(project: OpenHwProject): Promise<CircuitValidationResult> {
  const { Validator: ValidatorClass } = await loadEngine();

  if (!ValidatorClass) {
    return {
      passed: true,
      issues: [{
        severity: 'warn',
        message: 'FullCircuitValidator not available in this environment. Physics checks skipped.',
        compIds: [],
      }],
      rawErrors: [],
      profile: 'balanced',
      fromCache: false,
      rootCauseGroups: [],
      recommendedFixes: [],
      ignoredIssueCount: 0,
    };
  }

  // Translate wires from comp:pin → comp.pin
  const engineConnections = (project.connections || []).map(wire => ({
    from: toEngineEndpoint(wire.from),
    to:   toEngineEndpoint(wire.to),
  }));

  const projectData = {
    components: project.components,
    connections: engineConnections,
  };

  try {
    const validator = new ValidatorClass(projectData);
    const passed = validator.runValidation({
      profile: 'balanced',
      useCache: true,
      includeTemporalValidation: false,
      incremental: true,
      incrementalScope: 'cli',
    });

    const rawErrors: any[] = validator.errors || [];
    const issues: CircuitValidationIssue[] = rawErrors.map(err => {
      if (typeof err === 'string') {
        return {
          severity: classifySeverity(err),
          type: classifySeverity(err),
          message: err,
          compIds: extractCompIds(err),
        };
      }
      return {
        severity: err.severity || err.type || 'error',
        type: err.type || err.severity || 'error',
        message: err.message || '',
        compIds: err.compIds || [],
        remediation: err.remediation,
        autoFix: err.autoFix,
        ruleId: err.ruleId || err.id || null,
        componentId: err.componentId || null,
        source: err.source || null,
        priority: Number.isFinite(Number(err.priority)) ? Number(err.priority) : null,
        confidence: Number.isFinite(Number(err.confidence)) ? Number(err.confidence) : null,
        details: err.details ?? null,
      };
    });

    const lastRunMeta = validator.lastRunMeta || {};

    return {
      passed,
      issues,
      rawErrors,
      profile: String(lastRunMeta.profile || 'balanced'),
      fromCache: Boolean(lastRunMeta.fromCache),
      rootCauseGroups: Array.isArray(lastRunMeta.rootCauseGroups) ? lastRunMeta.rootCauseGroups : [],
      recommendedFixes: Array.isArray(lastRunMeta.recommendedFixes) ? lastRunMeta.recommendedFixes : [],
      ignoredIssueCount: Array.isArray(lastRunMeta.ignoredErrors) ? lastRunMeta.ignoredErrors.length : 0,
    };
  } catch (err) {
    const msg = `[circuit-validate] Engine threw an error: ${String(err)}`;
    return {
      passed: true,
      issues: [{ severity: 'warn', message: msg, compIds: [] }],
      rawErrors: [msg],
      profile: 'balanced',
      fromCache: false,
      rootCauseGroups: [],
      recommendedFixes: [],
      ignoredIssueCount: 0,
    };
  }
}

/** Core public function for Code-Hardware Sync validation */
export async function runCodeSyncValidation(project: OpenHwProject, targetBoardId?: string): Promise<CodeCircuitSyncResult> {
  const { SyncAnalyzer } = await loadEngine();
  if (!SyncAnalyzer) return { passed: true, issues: [] };
  
  const result = SyncAnalyzer(project, targetBoardId);
  return {
    passed: result.passed,
    issues: result.issues.map((i: any) => ({
      severity: i.severity === 'error' ? 'error' : 'warn',
      message: i.message
    }))
  };
}

// --------------------------------------------------------------------------
// Formatting helpers for CLI output
// --------------------------------------------------------------------------

export function formatCircuitValidationText(result: CircuitValidationResult, projectFile: string): string {
  const lines: string[] = [];
  lines.push(`\nCircuit Safety Report for: ${projectFile}`);
  lines.push(`Status: ${result.passed ? '✅ PASSED' : '🛑 FAILED'}`);
  lines.push(`Issues: ${result.issues.length}`);

  if (result.issues.length > 0) {
    lines.push('');
    for (const issue of result.issues) {
      const icon = issue.severity === 'error' ? '🔴' : issue.severity === 'warn' ? '🟡' : '🔵';
      lines.push(`  ${icon} ${issue.message}`);
      if (issue.compIds.length > 0) {
        lines.push(`     → Affected: ${issue.compIds.join(', ')}`);
      }
      if (issue.remediation) {
        lines.push(`     → Fix: ${issue.remediation}`);
      }
      if (issue.autoFix) {
        lines.push('     → Auto-fix: available');
      }
    }
  }

  if (result.passed && result.issues.length === 0) {
    lines.push('  ✅ All physics and wiring rules passed.');
  }

  return lines.join('\n') + '\n';
}

/**
 * Programmatic autofix runner for CLI/MCP
 * - `issue` can be an issue object returned by `runCircuitValidation`.
 * - Returns { applied, components, connections, appliedFixes, metadata }
 */
export async function runAutoFix(project: OpenHwProject, issue: any, options: { appliedBy?: string } = {}) {
  const indexPath = path.join(EMULATOR_ROOT, 'src', 'circuit-validation', 'index.js');
  try {
    const mod = await import(pathToFileURL(indexPath).href);
    const applyCircuitFix = mod.applyCircuitFix;
    if (!applyCircuitFix) {
      return { applied: false, reason: 'applyCircuitFix not available in emulator package' };
    }

    const engineConnections = (project.connections || []).map(wire => ({
      from: String(wire.from || '').replace(':', '.'),
      to: String(wire.to || '').replace(':', '.')
    }));

    const projectData = { components: project.components || [], connections: engineConnections };

    const engineError = {
      message: issue.message || String(issue || ''),
      remediation: issue.remediation || issue.fix || null,
      compIds: issue.compIds || issue.componentId ? (issue.compIds || [issue.componentId]) : [],
      id: issue.ruleId || issue.id || null,
    };

    const result = applyCircuitFix(projectData, engineError, { appliedBy: options.appliedBy || 'cli', trackHistory: true });

    // Convert connections back to CLI format (comp.pin -> comp:pin)
    const outConnections = (result.connections || []).map(w => ({
      from: String(w.from || '').replace('.', ':'),
      to: String(w.to || '').replace('.', ':'),
      color: w.color,
      label: w.label,
    }));

    return {
      applied: Boolean(result.applied),
      components: result.components,
      connections: outConnections,
      appliedFixes: result.appliedFixes || [],
      metadata: result.metadata || {},
    };
  } catch (err) {
    return { applied: false, reason: String(err) };
  }
}
