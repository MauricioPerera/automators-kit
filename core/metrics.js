/**
 * In-process metrics registry
 * Zero dependencies. Counters, gauges, and histograms, rendered in
 * Prometheus text exposition format — scrapeable by Prometheus itself, or
 * any tool that speaks that (near-universal) format, with zero client deps.
 *
 * In-process only: each process has its own registry. For a multi-process
 * deployment, either scrape each process on its own port, or push through
 * a separate aggregator (out of scope here — this module is the primitive,
 * not a full metrics pipeline).
 *
 * Usage:
 *   import { MetricsRegistry } from './core/metrics.js';
 *   const metrics = new MetricsRegistry();
 *   metrics.counter('http_requests_total', 'Total HTTP requests').inc({ method: 'GET', status: '200' });
 *   metrics.histogram('http_request_duration_ms', 'Request duration').observe({ method: 'GET' }, 42.5);
 *   // mount metrics.render() behind a /metrics route (text/plain; version=0.0.4)
 */

function _labelKey(labels) {
  const keys = Object.keys(labels || {}).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(',');
}

function _formatLabels(labels) {
  const keys = Object.keys(labels || {});
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',') + '}';
}

class Counter {
  constructor(name, help) {
    this.type = 'counter';
    this.name = name;
    this.help = help;
    this._values = new Map(); // labelKey -> { labels, value }
  }

  inc(labels = {}, n = 1) {
    const key = _labelKey(labels);
    const entry = this._values.get(key) || { labels, value: 0 };
    entry.value += n;
    this._values.set(key, entry);
  }
}

class Gauge {
  constructor(name, help) {
    this.type = 'gauge';
    this.name = name;
    this.help = help;
    this._values = new Map();
  }

  set(labels = {}, value) {
    this._values.set(_labelKey(labels), { labels, value });
  }

  inc(labels = {}, n = 1) {
    const key = _labelKey(labels);
    const entry = this._values.get(key) || { labels, value: 0 };
    entry.value += n;
    this._values.set(key, entry);
  }

  dec(labels = {}, n = 1) {
    this.inc(labels, -n);
  }
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

class Histogram {
  constructor(name, help, buckets = DEFAULT_BUCKETS) {
    this.type = 'histogram';
    this.name = name;
    this.help = help;
    this.buckets = buckets.slice().sort((a, b) => a - b);
    this._values = new Map(); // labelKey -> { labels, sum, count, bucketCounts }
  }

  observe(labels = {}, value) {
    const key = _labelKey(labels);
    let entry = this._values.get(key);
    if (!entry) {
      entry = { labels, sum: 0, count: 0, bucketCounts: this.buckets.map(() => 0) };
      this._values.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.bucketCounts[i] += 1;
    }
  }
}

const KIND = { counter: Counter, gauge: Gauge, histogram: Histogram };

export class MetricsRegistry {
  constructor() {
    this._metrics = new Map();
  }

  counter(name, help) { return this._getOrCreate('counter', name, help); }
  gauge(name, help) { return this._getOrCreate('gauge', name, help); }
  histogram(name, help, buckets) { return this._getOrCreate('histogram', name, help, buckets); }

  /** @private */
  _getOrCreate(type, name, help, buckets) {
    const existing = this._metrics.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(`Metric '${name}' already registered as ${existing.type}, not ${type}`);
      }
      return existing;
    }
    const metric = new KIND[type](name, help, buckets);
    this._metrics.set(name, metric);
    return metric;
  }

  /** Render all registered metrics in Prometheus text exposition format. */
  render() {
    const lines = [];
    for (const m of this._metrics.values()) {
      if (m.help) lines.push(`# HELP ${m.name} ${m.help}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);

      for (const entry of m._values.values()) {
        if (m.type === 'histogram') {
          // entry.bucketCounts[i] is already the cumulative count of
          // observations <= buckets[i] (observe() increments every
          // qualifying bucket per call, not just the first one it falls
          // into) -- Prometheus's own `le="X"` bucket semantics. No
          // further accumulation here.
          for (let i = 0; i < m.buckets.length; i++) {
            lines.push(`${m.name}_bucket${_formatLabels({ ...entry.labels, le: String(m.buckets[i]) })} ${entry.bucketCounts[i]}`);
          }
          lines.push(`${m.name}_bucket${_formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
          lines.push(`${m.name}_sum${_formatLabels(entry.labels)} ${entry.sum}`);
          lines.push(`${m.name}_count${_formatLabels(entry.labels)} ${entry.count}`);
        } else {
          lines.push(`${m.name}${_formatLabels(entry.labels)} ${entry.value}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }
}
