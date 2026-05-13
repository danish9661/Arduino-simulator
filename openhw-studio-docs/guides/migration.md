# Validation Migration Guide

## What changed

Validation now returns structured issues instead of plain strings. Each issue can include:

- `severity` (`error`, `warn`, or `info`)
- `message`
- `compIds`
- `remediation`
- `autoFix`
- optional `ruleId`, `componentId`, `priority`, and `details`

This applies to the emulator engine, the WebUI validation panel, and the CLI/MCP outputs.

## WebUI behavior

The simulator UI now reads structured validation issues and uses:

- severity to color and label the issue
- remediation text as a short fix hint
- `autoFix` to decide whether the FIX button should be shown

If you add a new validator, return a structured issue via `createValidationIssue(...)` instead of a raw string.

## CLI and MCP behavior

The CLI adapter now preserves structured engine errors in both:

- human-readable text output
- JSON output returned by MCP tools like `circuit_validate`

That means downstream tools can inspect `issues[]` without parsing strings.

## How to validate the integration

Recommended checks:

```bash
npm --prefix "c:\Users\Danish\Documents\simulator\openhw-studio-cli" run typecheck
npm --prefix "c:\Users\Danish\Documents\simulator\openhw-studio-cli" run test:mcp:contracts
npm --prefix "c:\Users\Danish\Documents\simulator\openhw-studio-cli" run test:mcp:smoke
```

## Notes for contributors

- Prefer `createValidationIssue(...)` for new component validators.
- Keep `severity` and `type` aligned when emitting or transforming issues.
- If you extend the issue schema, update the WebUI renderer and the CLI/MCP contract tests together.
- For this workspace, MCP smoke tests should use the API base URL `http://127.0.0.1:5001/api`.


