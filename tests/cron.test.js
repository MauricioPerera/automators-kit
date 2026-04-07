/**
 * Tests: core/cron.js
 */

import { describe, it, expect } from 'bun:test';
import { CronScheduler, parseCron, matchesCron } from '../core/cron.js';

describe('parseCron', () => {
  it('parses * (every)', () => {
    const s = parseCron('* * * * *');
    expect(s.minute.size).toBe(60);
    expect(s.hour.size).toBe(24);
  });

  it('parses specific value', () => {
    const s = parseCron('30 9 * * *');
    expect(s.minute.has(30)).toBe(true);
    expect(s.minute.size).toBe(1);
    expect(s.hour.has(9)).toBe(true);
  });

  it('parses range', () => {
    const s = parseCron('0 9-17 * * *');
    expect(s.hour.has(9)).toBe(true);
    expect(s.hour.has(17)).toBe(true);
    expect(s.hour.has(8)).toBe(false);
    expect(s.hour.size).toBe(9);
  });

  it('parses step', () => {
    const s = parseCron('*/15 * * * *');
    expect(s.minute.has(0)).toBe(true);
    expect(s.minute.has(15)).toBe(true);
    expect(s.minute.has(30)).toBe(true);
    expect(s.minute.has(45)).toBe(true);
    expect(s.minute.size).toBe(4);
  });

  it('parses comma-separated', () => {
    const s = parseCron('0 9,12,18 * * *');
    expect(s.hour.size).toBe(3);
    expect(s.hour.has(9)).toBe(true);
    expect(s.hour.has(12)).toBe(true);
    expect(s.hour.has(18)).toBe(true);
  });

  it('parses day of week', () => {
    const s = parseCron('0 9 * * 1-5');
    expect(s.dow.has(1)).toBe(true);
    expect(s.dow.has(5)).toBe(true);
    expect(s.dow.has(0)).toBe(false); // Sunday
    expect(s.dow.has(6)).toBe(false); // Saturday
  });

  it('rejects invalid step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow();
  });

  it('rejects invalid range', () => {
    expect(() => parseCron('0 17-9 * * *')).toThrow();
  });

  it('rejects out of range', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* 25 * * *')).toThrow();
  });

  it('rejects wrong field count', () => {
    expect(() => parseCron('* * *')).toThrow();
  });
});

describe('matchesCron', () => {
  it('matches exact time', () => {
    const schedule = parseCron('30 9 * * *');
    const date = new Date(2026, 0, 15, 9, 30, 0); // Jan 15 2026 09:30
    expect(matchesCron(date, schedule)).toBe(true);
  });

  it('does not match wrong minute', () => {
    const schedule = parseCron('30 9 * * *');
    const date = new Date(2026, 0, 15, 9, 31, 0);
    expect(matchesCron(date, schedule)).toBe(false);
  });

  it('matches day of week', () => {
    const schedule = parseCron('0 9 * * 1'); // Monday
    const monday = new Date(2026, 0, 12, 9, 0, 0); // Jan 12 2026 is Monday
    expect(matchesCron(monday, schedule)).toBe(true);
  });
});

describe('CronScheduler', () => {
  it('add and list jobs', () => {
    const cron = new CronScheduler();
    cron.add('cleanup', '0 * * * *', async () => {});
    cron.add('report', '0 9 * * 1', async () => {});
    const jobs = cron.list();
    expect(jobs.length).toBe(2);
    expect(jobs[0].name).toBe('cleanup');
    expect(jobs[1].name).toBe('report');
  });

  it('remove job', () => {
    const cron = new CronScheduler();
    cron.add('temp', '* * * * *', async () => {});
    cron.remove('temp');
    expect(cron.list().length).toBe(0);
  });

  it('toggle active', () => {
    const cron = new CronScheduler();
    cron.add('job', '* * * * *', async () => {});
    expect(cron.list()[0].active).toBe(true);
    cron.toggle('job', false);
    expect(cron.list()[0].active).toBe(false);
  });

  it('run manually', async () => {
    let ran = false;
    const cron = new CronScheduler();
    cron.add('manual', '0 0 1 1 *', async () => { ran = true; }); // Jan 1 midnight
    await cron.run('manual');
    expect(ran).toBe(true);
    expect(cron.list()[0].runs).toBe(1);
  });

  it('tracks errors', async () => {
    const cron = new CronScheduler();
    cron.add('fail', '* * * * *', async () => { throw new Error('boom'); });
    await cron.run('fail');
    expect(cron.list()[0].errors).toBe(1);
  });

  it('start and stop', () => {
    const cron = new CronScheduler({ tickInterval: 100000 });
    cron.add('job', '* * * * *', async () => {});
    cron.start();
    expect(cron._timer).not.toBeNull();
    cron.stop();
    expect(cron._timer).toBeNull();
  });
});
