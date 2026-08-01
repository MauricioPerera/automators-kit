/**
 * Shell A2E Runner — end-to-end regression test.
 * Mirrors examples/shell-a2e-runner/setup.js (reuses pipelines.js/
 * tools.js so the demo and the test can't drift apart).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { runPipeline } from '../examples/shell-a2e-runner/tools.js';

let app;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'shell-a2e-runner-test-secret!!!' });
  app.shell.registry.register('pipeline', 'run', { description: 'run' }, async (args) => runPipeline(args.op, args));
});

describe('Shell A2E runner: a shell command builds and executes a fresh a2e.js pipeline per call', () => {
  it('text-transform pipeline, parameterized by the shell args, formats the given text', async () => {
    const { results, errors } = await runPipeline('text-transform', { text: 'hello world', format: 'title' });
    expect(errors).toEqual({});
    expect(results.result).toBe('Hello World');
  });

  it('calc pipeline runs the requested arithmetic operation, not the pipeline selector', async () => {
    // Regression: `op` selects the pipeline ('calc'); the arithmetic
    // operation is a SEPARATE field ('operation') precisely because an
    // earlier draft of this example collided the two under one name.
    const { results, errors } = await runPipeline('calc', { a: 10, b: 3, operation: 'multiply' });
    expect(errors).toEqual({});
    expect(results.result).toBe(30);
  });

  it('defaults calc to add when no operation is given', async () => {
    const { results } = await runPipeline('calc', { a: 4, b: 5 });
    expect(results.result).toBe(9);
  });

  it('an unknown pipeline name throws a clear, listing error', () => {
    expect(runPipeline('does-not-exist', {})).rejects.toThrow(/Unknown pipeline.*text-transform.*calc|Unknown pipeline/);
  });

  it('two concurrent runPipeline calls with different inputs never cross-contaminate results (fresh executor per call)', async () => {
    const [a, b] = await Promise.all([
      runPipeline('text-transform', { text: 'alpha', format: 'upper' }),
      runPipeline('text-transform', { text: 'beta', format: 'upper' }),
    ]);
    expect(a.results.result).toBe('ALPHA');
    expect(b.results.result).toBe('BETA');
  });

  it('works end to end over the real HTTP shell command, not just the direct function call', async () => {
    const res = await app.handle(req('pipeline:run --op calc --a 20 --b 4 --operation divide'));
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.results.result).toBe(5);
  });
});
