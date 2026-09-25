// iaADN - Evolved tools: functions an instance wrote for itself (CODE genes)
// and can call while solving a task. Every call runs in the Sandbox; a tool's
// code is re-validated before first use, since genomes also arrive from peers.

import { createHash } from 'crypto';
import { CodeValidator } from './code-validator.js';

export const MAX_TOOLS = 3;
export const MAX_TOOL_CALLS = 2;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_RESULT_CHARS = 500;

const validator = new CodeValidator();
const validity = new Map(); // code hash -> boolean

export function isToolSafe(code) {
  const key = createHash('sha256').update(code).digest('hex');
  if (!validity.has(key)) validity.set(key, validator.validate(code).valid);
  return validity.get(key);
}

// Normalize a CODE gene into a tool, or null if it isn't a usable one.
export function geneToTool(gene) {
  const value = gene?.value;
  if (!value || typeof value.code !== 'string') return null;
  const name = value.name || gene.name;
  if (!TOOL_NAME.test(name || '')) return null;
  return {
    name,
    description: String(value.description || value.spec || '').slice(0, 200),
    code: value.code,
    domain: value.domain || null,
  };
}

export function toolsPrompt(tools) {
  const lines = tools.map(t => `- ${t.name}: ${t.description}`);
  return [
    'You have these tools. To use one, reply with a single line exactly like:',
    'TOOL <name> <JSON input>',
    'You will get the result back and can then give your final answer.',
    ...lines,
  ].join('\n');
}

// Find a `TOOL name {json}` line naming one of the given tools.
export function parseToolCall(content, tools) {
  const match = String(content).match(/^\s*TOOL\s+([a-z][a-z0-9_]*)\s+(.+?)\s*$/m);
  if (!match) return null;
  const tool = tools.find(t => t.name === match[1]);
  if (!tool) return null;
  let input;
  try {
    input = JSON.parse(match[2]);
  } catch {
    input = match[2];
  }
  return { tool, input };
}

// Run a tool and return its result as text for the model. Failures come back
// as an error string — a broken tool costs the task, never the evaluation.
export function runTool(sandbox, tool, input) {
  if (!isToolSafe(tool.code)) return 'error: tool rejected by validator';
  const result = sandbox.execute(tool.code, { input });
  if (!result.success) return `error: ${result.error}`;
  let text;
  try {
    text = JSON.stringify(result.result);
  } catch {
    text = String(result.result);
  }
  return (text ?? 'null').slice(0, MAX_RESULT_CHARS);
}
