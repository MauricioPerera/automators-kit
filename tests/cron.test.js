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

  it('parses explicit range/step, capped at range upper bound', () => {
    const s = parseCron('5-10/2 * * * *');
    const mins = Array.from(s.minute).sort((a, b) => a - b);
    expect(mins).toEqual([5, 7, 9]);
    expect(s.minute.has(11)).toBe(false);
    expect(s.minute.has(13)).toBe(false);
    expect(s.minute.has(59)).toBe(false);
    expect(s.minute.size).toBe(3);
  });

  it('parses */N (star step) using full field range — unchanged', () => {
    const s = parseCron('*/15 * * * *');
    const mins = Array.from(s.minute).sort((a, b) => a - b);
    expect(mins).toEqual([0, 15, 30, 45]);
    expect(s.minute.size).toBe(4);
  });

  it('parses N/step (bare, no explicit range) up to field max — unchanged', () => {
    const s = parseCron('5/2 * * * *');
    expect(s.minute.has(5)).toBe(true);
    expect(s.minute.has(7)).toBe(true);
    expect(s.minute.has(57)).toBe(true);
    expect(s.minute.has(59)).toBe(true);
    // 5 + 2k up to 59 → 28 values
    expect(s.minute.size).toBe(28);
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

  it('does not run overlapping executions of the same job (reentrancy guard)', async () => {
    let inFlight = false;
    let overlap = false;
    let resolveSlow;
    const slow = new Promise(r => { resolveSlow = r; });
    const cron = new CronScheduler();
    cron.add('slow', '* * * * *', async () => {
      if (inFlight) overlap = true;
      inFlight = true;
      await slow;
      inFlight = false;
    });
    const task = cron._tasks.get('slow');

    // Fire two concurrent executions — simulates a second tick landing while the
    // first handler is still running (handler slower than the tick interval).
    const p1 = cron._execute(task);
    const p2 = cron._execute(task);

    // The second invocation must be skipped synchronously, not started.
    expect(task.running).toBe(true);
    expect(task.skippedOverlaps).toBe(1);
    expect(overlap).toBe(false);

    resolveSlow();
    await Promise.all([p1, p2]);

    expect(overlap).toBe(false);
    expect(task.runs).toBe(1);
    expect(task.running).toBe(false);
  });

  it('clears running flag after completion and allows a later execution', async () => {
    let calls = 0;
    const cron = new CronScheduler();
    cron.add('j', '* * * * *', async () => { calls++; });
    const task = cron._tasks.get('j');

    await cron._execute(task);
    expect(task.running).toBe(false);
    expect(task.runs).toBe(1);

    // A later tick should fire normally — the guard was released.
    await cron._execute(task);
    expect(task.runs).toBe(2);
    expect(calls).toBe(2);
  });

  it('clears running flag even when the handler throws', async () => {
    let calls = 0;
    const cron = new CronScheduler();
    cron.add('j', '* * * * *', async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    const task = cron._tasks.get('j');

    await cron._execute(task);
    expect(task.running).toBe(false);
    expect(task.errors).toBe(1);

    // After a throwing run, a later execution must still proceed normally.
    await cron._execute(task);
    expect(task.runs).toBe(1);
    expect(calls).toBe(2);
  });
});

// CORRECTNESS (2026-08-03, verified from a full-codebase audit lead):
// matchesCron ANDed day-of-month with day-of-week unconditionally. POSIX/Vixie
// cron ORs them when BOTH are restricted, so `0 0 1 * 1` means "midnight on
// the 1st OR any Monday". Measured before the fix: it fired ONCE in 2026
// instead of 63 times -- a standard crontab line pasted in became a schedule
// that almost never runs, with no error anywhere.
describe('day-of-month / day-of-week follow POSIX OR semantics', () => {
  const firingsIn2026 = (expr) => {
    const s = parseCron(expr);
    let n = 0;
    for (let m = 0; m < 12; m++) {
      for (let day = 1; day <= 31; day++) {
        const d = new Date(2026, m, day, 0, 0);
        if (d.getMonth() !== m) continue;
        if (matchesCron(d, s)) n++;
      }
    }
    return n;
  };

  it('ORs them when BOTH are restricted', () => {
    const s = parseCron('0 0 1 * 1'); // the 1st, or any Monday
    expect(matchesCron(new Date(2026, 6, 1, 0, 0), s)).toBe(true);  // Wed the 1st
    expect(matchesCron(new Date(2026, 6, 6, 0, 0), s)).toBe(true);  // a Monday
    expect(matchesCron(new Date(2026, 5, 1, 0, 0), s)).toBe(true);  // both
    expect(matchesCron(new Date(2026, 6, 7, 0, 0), s)).toBe(false); // neither
    expect(firingsIn2026('0 0 1 * 1')).toBe(63);                    // was 1
  });

  it('ANDs them when only ONE is restricted (an OR there would match every day)', () => {
    expect(firingsIn2026('0 0 * * 1')).toBe(52); // Mondays only
    expect(firingsIn2026('0 0 1 * *')).toBe(12); // 1st of each month only
  });

  it('is unaffected when neither is restricted', () => {
    expect(firingsIn2026('0 0 * * *')).toBe(365);
  });

  it('still ANDs the other fields (month keeps narrowing the result)', () => {
    expect(firingsIn2026('0 0 1 1 *')).toBe(1); // Jan 1st only
  });

  it('treats an explicit full range as a RESTRICTION, unlike *', () => {
    // `0-6` covers every weekday but is still a restriction, so pairing it
    // with a restricted dom must OR (matching cron), not AND.
    expect(matchesCron(new Date(2026, 6, 7, 0, 0), parseCron('0 0 1 * 0-6'))).toBe(true);
    expect(matchesCron(new Date(2026, 6, 7, 0, 0), parseCron('0 0 1 * *'))).toBe(false);
  });
});
