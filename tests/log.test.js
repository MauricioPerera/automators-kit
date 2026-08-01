/**
 * Tests: core/log.js
 */

import { describe, it, expect } from 'bun:test';
import { createLogger } from '../core/log.js';

describe('createLogger', () => {
  it('emits a structured entry with ts/level/module/msg plus extra fields', () => {
    const entries = [];
    const log = createLogger('workflow', { sink: (e) => entries.push(e) });
    log.info('execution started', { workflowId: 'wf1', executionId: 'e1' });

    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].module).toBe('workflow');
    expect(entries[0].msg).toBe('execution started');
    expect(entries[0].workflowId).toBe('wf1');
    expect(entries[0].executionId).toBe('e1');
    expect(typeof entries[0].ts).toBe('string');
    expect(new Date(entries[0].ts).toString()).not.toBe('Invalid Date');
  });

  it('debug/info/warn/error all route to the sink with the right level', () => {
    const entries = [];
    const log = createLogger('m', { sink: (e) => entries.push(e), level: 'debug' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('filters out entries below the configured minimum level', () => {
    const entries = [];
    const log = createLogger('m', { sink: (e) => entries.push(e), level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('defaults to info level when unset', () => {
    const entries = [];
    const log = createLogger('m', { sink: (e) => entries.push(e) });
    log.debug('should be filtered');
    log.info('should appear');
    expect(entries.length).toBe(1);
    expect(entries[0].msg).toBe('should appear');
  });

  it('serializes an Error field with name/message/stack instead of {}', () => {
    const captured = [];
    const origError = console.error;
    console.error = (line) => captured.push(line);
    try {
      const log = createLogger('m');
      log.error('failed', { err: new Error('boom') });
    } finally {
      console.error = origError;
    }
    const parsed = JSON.parse(captured[0]);
    expect(parsed.err.name).toBe('Error');
    expect(parsed.err.message).toBe('boom');
    expect(typeof parsed.err.stack).toBe('string');
  });

  it('default sink routes error/warn/info to the matching console method', () => {
    const calls = { log: 0, warn: 0, error: 0 };
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => calls.log++;
    console.warn = () => calls.warn++;
    console.error = () => calls.error++;
    try {
      const log = createLogger('m');
      log.info('i');
      log.warn('w');
      log.error('e');
    } finally {
      Object.assign(console, orig);
    }
    expect(calls).toEqual({ log: 1, warn: 1, error: 1 });
  });
});
