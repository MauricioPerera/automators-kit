/**
 * Tests: core/metrics.js
 */

import { describe, it, expect } from 'bun:test';
import { MetricsRegistry } from '../core/metrics.js';

describe('MetricsRegistry: counter', () => {
  it('increments by 1 by default, and by n when given', () => {
    const m = new MetricsRegistry();
    const c = m.counter('requests_total', 'total requests');
    c.inc();
    c.inc({}, 4);
    expect(m.render()).toContain('requests_total 5');
  });

  it('tracks separate values per distinct label set', () => {
    const m = new MetricsRegistry();
    const c = m.counter('http_requests_total');
    c.inc({ method: 'GET' });
    c.inc({ method: 'GET' });
    c.inc({ method: 'POST' });
    const out = m.render();
    expect(out).toContain('http_requests_total{method="GET"} 2');
    expect(out).toContain('http_requests_total{method="POST"} 1');
  });

  it('label order does not create separate series (labels are sorted internally)', () => {
    const m = new MetricsRegistry();
    const c = m.counter('x');
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });
    expect(m.render()).toContain('x{a="1",b="2"} 2');
  });

  it('calling counter()/gauge() again with the same name returns the same instance', () => {
    const m = new MetricsRegistry();
    const c1 = m.counter('x');
    const c2 = m.counter('x');
    expect(c1).toBe(c2);
  });

  it('registering the same name as a different metric type throws', () => {
    const m = new MetricsRegistry();
    m.counter('x');
    expect(() => m.gauge('x')).toThrow();
  });
});

describe('MetricsRegistry: gauge', () => {
  it('set() replaces the value; inc()/dec() adjust it', () => {
    const m = new MetricsRegistry();
    const g = m.gauge('queue_depth');
    g.set({}, 10);
    expect(m.render()).toContain('queue_depth 10');
    g.inc({}, 3);
    expect(m.render()).toContain('queue_depth 13');
    g.dec({}, 5);
    expect(m.render()).toContain('queue_depth 8');
  });
});

describe('MetricsRegistry: histogram', () => {
  it('bucket counts are cumulative (le=X means count of observations <= X), not per-bucket', () => {
    const m = new MetricsRegistry();
    const h = m.histogram('duration_ms', 'duration', [10, 50, 100]);
    h.observe({}, 5);   // falls in all 3 buckets
    h.observe({}, 30);  // falls in 50, 100
    h.observe({}, 200); // falls in none (+Inf only)

    const out = m.render();
    expect(out).toContain('duration_ms_bucket{le="10"} 1');
    expect(out).toContain('duration_ms_bucket{le="50"} 2');
    expect(out).toContain('duration_ms_bucket{le="100"} 2');
    expect(out).toContain('duration_ms_bucket{le="+Inf"} 3');
    expect(out).toContain('duration_ms_sum 235');
    expect(out).toContain('duration_ms_count 3');
  });

  it('a value exactly on a bucket boundary counts as <= that bucket', () => {
    const m = new MetricsRegistry();
    const h = m.histogram('x', '', [10]);
    h.observe({}, 10);
    expect(m.render()).toContain('x_bucket{le="10"} 1');
  });
});

describe('MetricsRegistry: render() format', () => {
  it('includes HELP/TYPE lines when help text is provided', () => {
    const m = new MetricsRegistry();
    m.counter('x', 'the help text');
    const out = m.render();
    expect(out).toContain('# HELP x the help text');
    expect(out).toContain('# TYPE x counter');
  });

  it('omits the HELP line when no help text is given', () => {
    const m = new MetricsRegistry();
    m.counter('x');
    expect(m.render()).not.toContain('# HELP');
  });

  it('escapes quotes and backslashes in label values', () => {
    const m = new MetricsRegistry();
    m.counter('x').inc({ path: '/a"b\\c' });
    expect(m.render()).toContain('x{path="/a\\"b\\\\c"} 1');
  });

  it('a metric with zero observations renders only HELP/TYPE, no series line', () => {
    const m = new MetricsRegistry();
    m.counter('x', 'help');
    const lines = m.render().trim().split('\n');
    expect(lines).toEqual(['# HELP x help', '# TYPE x counter']);
  });
});
