// iaADN - Evolved tools: written by the instance, used while solving tasks,
// kept only when they measurably help. Uses the real FitnessEvaluator,
// CodeGenerator, Sandbox and AutoProgram with a scripted engine standing in
// for the model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FitnessEvaluator } from '../src/evolution/fitness.js';
import { TaskBank } from '../src/evaluation/task-bank.js';
import { numericMatch } from '../src/evaluation/verify.js';
import { AutoProgram, TOOL_SPECS } from '../src/daemon/auto-program.js';
import { Genome } from '../src/genome/genome.js';
import { Gene, GENE_TYPES } from '../src/genome/gene.js';
import { Lineage } from '../src/genome/lineage.js';
import { SafetyGuardian } from '../src/safety/guardian.js';
import { AuditLog } from '../src/safety/audit-log.js';
import { Sandbox } from '../src/selfprog/sandbox.js';
import { parseToolCall, runTool } from '../src/selfprog/tools.js';

// A small recursive-descent calculator, the kind of tool a model might write
const CALC_CODE = `
var s = String(input), i = 0;
function peek() { while (s[i] === ' ') i++; return s[i]; }
function num() { peek(); var st = i; while (i < s.length && /[0-9.]/.test(s[i])) i++; return parseFloat(s.slice(st, i)); }
function atom() { var c = peek(); if (c === '(') { i++; var v = add(); peek(); i++; return v; } if (c === '-') { i++; return -atom(); } return num(); }
function pow() { var b = atom(); if (peek() === '*' && s[i + 1] === '*') { i += 2; return Math.pow(b, pow()); } return b; }
function mul() { var v = pow(); for (var k = 0; k < 1000; k++) { var c = peek(); if (c === '*' && s[i + 1] !== '*') { i++; v *= pow(); } else if (c === '/') { i++; v /= pow(); } else if (c === '%') { i++; v %= pow(); } else break; } return v; }
function add() { var v = mul(); for (var k = 0; k < 1000; k++) { var c = peek(); if (c === '+') { i++; v += mul(); } else if (c === '-') { i++; v -= mul(); } else break; } return v; }
return add();
`;

const MATH = [['37 * 91', 3367], ['(125 + 375) / 4', 125], ['2 ** 12', 4096], ['1000 - 17 * 23', 609]];
const tasks = MATH.map(([expr, answer], i) => ({
  id: `m${i}`, domain: 'math', split: 'train',
  prompt: `Compute ${expr}`,
  verify: (response) => numericMatch(response, answer),
}));

// Can't do arithmetic by itself; uses a calc tool when one is offered.
function scriptedEngine() {
  return {
    ready: true,
    getStats: () => ({ avgTokensPerSec: 10 }),
    complete: async (messages, opts = {}) => {
      const content = messages[messages.length - 1].content;
      if (content.startsWith('You are a code generator')) return { content: '```js\n' + CALC_CODE + '\n```' };
      const result = content.match(/Result: (.+)/);
      if (result) return { content: `The answer is ${result[1]}` };
      const expr = content.match(/Compute (.+)/);
      if (expr && (opts.systemPrompt || '').includes('- calc:')) {
        return { content: `TOOL calc ${JSON.stringify(expr[1])}` };
      }
      return { content: 'I think it is 0' };
    },
  };
}

function withTool(genome, code, name = 'calc') {
  genome.chromosomes.specialization.addGene(new Gene({
    type: GENE_TYPES.CODE, name: `tool_${name}`, value: { name, description: 'calculator', code },
  }));
  return genome;
}

describe('Evolved tools', () => {
  it('a written calc tool passes its own unit tests in the sandbox', () => {
    const result = new Sandbox().executeWithTests(CALC_CODE, TOOL_SPECS.math.tests);
    assert.equal(result.passRate, 1);
  });

  it('runTasks actually calls the tool, turning failures into passes', async () => {
    const evaluator = new FitnessEvaluator({ taskBank: new TaskBank(tasks) });
    const engine = scriptedEngine();

    const without = await evaluator.runTasks(Genome.createGenesis('n'), engine, tasks);
    const withCalc = await evaluator.runTasks(withTool(Genome.createGenesis('n'), CALC_CODE), engine, tasks);

    assert.equal(without.correctCount, 0);
    assert.equal(withCalc.correctCount, tasks.length);
    assert.ok(withCalc.results.every(r => r.toolCalls === 1));
  });

  it('a broken tool costs the task, never the evaluation', async () => {
    const evaluator = new FitnessEvaluator({ taskBank: new TaskBank(tasks) });
    const broken = withTool(Genome.createGenesis('n'), 'throw new Error("boom");');
    const run = await evaluator.runTasks(broken, scriptedEngine(), tasks);
    assert.equal(run.total, tasks.length);
    assert.equal(run.correctCount, 0);
  });

  it('a tool that fails validation is never executed (e.g. adopted from a peer)', () => {
    const evil = { name: 'calc', code: "return Math.max.constructor('return pro' + 'cess')().pid;" };
    assert.match(runTool(new Sandbox(), evil, '1'), /rejected by validator/);
  });

  it('parses tool calls only for tools the instance has', () => {
    const tools = [{ name: 'calc', code: '' }];
    assert.deepEqual(parseToolCall('TOOL calc "1 + 1"', tools).input, '1 + 1');
    assert.equal(parseToolCall('TOOL rm_rf {}', tools), null);
    assert.equal(parseToolCall('the answer is 2', tools), null);
  });

  it('AutoProgram writes a calc tool end to end and keeps it because it helps', async () => {
    const auditLog = new AuditLog();
    const guardian = new SafetyGuardian(auditLog);
    const engine = scriptedEngine();
    const evaluator = new FitnessEvaluator({ taskBank: new TaskBank(tasks) });
    const best = { genome: Genome.createGenesis('n'), fitness: 0.4 };
    const added = [];
    const population = {
      getBest: () => best,
      fitnessEvaluator: evaluator,
      addInstance: (genome, fitness) => added.push({ genome, fitness }),
    };

    const autoProgram = new AutoProgram({ population, lineage: new Lineage(), inferenceEngine: engine, guardian, auditLog });
    const result = await autoProgram.run();

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.tool, 'calc');
    assert.equal(result.parentCorrect, 0);
    assert.equal(result.candidateCorrect, tasks.length);
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].genome.getTools().map(t => t.name), ['calc']);
    assert.equal(best.genome.getTools().length, 0);
  });
});
