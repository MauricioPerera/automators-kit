/**
 * Tests: core/net-guard.js (SSRF guard)
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { assertPublicUrl, safeFetch, assertPublicDns, _setDnsModuleForTests } from '../core/net-guard.js';

const blocks = (url) => expect(() => assertPublicUrl(url)).toThrow();
const allows = (url) => expect(() => assertPublicUrl(url)).not.toThrow();

describe('assertPublicUrl', () => {
  it('blocks IPv4 loopback / RFC1918 / link-local / unspecified', () => {
    for (const u of [
      'http://127.0.0.1/', 'http://127.1.2.3/',
      'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/',
    ]) blocks(u);
  });

  it('blocks alternate IPv4 encodings (WHATWG URL normalizes them first)', () => {
    for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/']) blocks(u);
  });

  it('blocks localhost and non-http(s) schemes', () => {
    blocks('http://localhost/');
    blocks('file:///etc/passwd');
    blocks('gopher://example.com/');
  });

  // SECURITY (2026-08-03, full-codebase audit): the old check read only
  // `host.split(':')[0]`, which is the EMPTY STRING for any `::`-compressed
  // address -- parseInt('') is NaN, so every range check was skipped. All of
  // these were verified ALLOWED before the fix, including the cloud-metadata
  // address, which is the whole reason this guard exists.
  describe('IPv6 forms that previously slipped through', () => {
    it('blocks IPv4-mapped addresses, including the normalized hex form', () => {
      for (const u of [
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:169.254.169.254]/latest/meta-data/',
        'http://[::ffff:7f00:1]/',          // what new URL() normalizes the first one to
        'http://[::ffff:10.0.0.1]/',
        'http://[0:0:0:0:0:ffff:7f00:1]/',  // fully expanded
      ]) blocks(u);
    });

    it('blocks IPv4-compatible addresses', () => {
      blocks('http://[::127.0.0.1]/');
    });

    it('blocks unique-local fc00::/7 (the IPv6 RFC1918), previously unchecked entirely', () => {
      for (const u of ['http://[fd00::1]/', 'http://[fc00::1]/', 'http://[fdff:ffff::1]/']) blocks(u);
    });

    it('blocks loopback, unspecified and link-local in every notation', () => {
      for (const u of [
        'http://[::1]/', 'http://[::]/',
        'http://[0:0:0:0:0:0:0:1]/', 'http://[0:0:0:0:0:0:0:0]/',
        'http://[fe80::1]/', 'http://[febf::1]/',
      ]) blocks(u);
    });
  });

  it('still allows genuinely public destinations (the guard must not over-block)', () => {
    for (const u of [
      'https://example.com/', 'https://8.8.8.8/', 'http://172.32.0.1/',
      'http://[2606:4700:4700::1111]/',   // public Cloudflare DNS over IPv6
      'http://[2001:4860:4860::8888]/',
    ]) allows(u);
  });

  it('rejects a malformed IPv6 literal rather than silently passing it', () => {
    blocks('http://[::ffff:1:2:3:4:5:6:7:8]/');
    blocks('http://[12345::1]/');
  });
});

// SECURITY (2026-08-03, full-codebase audit): `assertPublicUrl` validates only
// the URL it is handed, and `fetch` defaults to `redirect: 'follow'` -- so an
// attacker-controlled PUBLIC host (which the guard allows) reached any
// internal destination the moment it answered `302 Location:
// http://127.0.0.1/`. Verified live: the guard blocked the direct attempt and
// the redirect delivered the same internal body anyway.
//
// The network layer is stubbed here, not the guard -- these exercise
// safeFetch's real redirect handling against synthetic responses.
describe('safeFetch: the guard applies to every hop, not just the first', () => {
  const realFetch = globalThis.fetch;
  let seen;

  const stubRoutes = (routes) => {
    seen = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      seen.push({ url: u, method: init?.method ?? 'GET', auth: init?.headers?.Authorization ?? null, body: init?.body ?? null });
      const r = routes[u];
      if (r) return new Response(null, { status: r.status, headers: { Location: r.to } });
      return new Response('FINAL', { status: 200 });
    };
  };

  afterEach(() => { globalThis.fetch = realFetch; });

  it('refuses a redirect from an allowed public host into loopback', async () => {
    stubRoutes({ 'https://evil.test/': { status: 302, to: 'http://127.0.0.1:9/' } });
    await expect(safeFetch('https://evil.test/')).rejects.toThrow(/blocked internal destination: 127\.0\.0\.1/);
  });

  it('refuses a redirect into the cloud-metadata address', async () => {
    stubRoutes({ 'https://evil.test/': { status: 302, to: 'http://169.254.169.254/latest/meta-data/' } });
    await expect(safeFetch('https://evil.test/')).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('refuses an internal destination reached at the END of a public chain', async () => {
    stubRoutes({
      'https://a.test/': { status: 302, to: 'https://b.test/' },
      'https://b.test/': { status: 302, to: 'http://10.0.0.1/' },
    });
    await expect(safeFetch('https://a.test/')).rejects.toThrow(/10\.0\.0\.1/);
  });

  it('still follows a legitimate public -> public redirect', async () => {
    stubRoutes({ 'https://a.test/': { status: 302, to: 'https://b.test/ok' } });
    const res = await safeFetch('https://a.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('FINAL');
  });

  it('drops Authorization when the hop crosses origin (redirect-to-credential-theft)', async () => {
    stubRoutes({ 'https://a.test/': { status: 302, to: 'https://other.test/x' } });
    await safeFetch('https://a.test/', { headers: { Authorization: 'Bearer SECRET' } });
    expect(seen[0].auth).toBe('Bearer SECRET');   // the host the caller named
    expect(seen[1].auth).toBeNull();              // the host the redirect named
  });

  it('keeps Authorization on a same-origin hop (the common real case)', async () => {
    stubRoutes({ 'https://same.test/': { status: 302, to: 'https://same.test/next' } });
    await safeFetch('https://same.test/', { headers: { Authorization: 'Bearer SECRET' } });
    expect(seen[1].auth).toBe('Bearer SECRET');
  });

  it('rewrites method/body the way fetch itself would (303 -> GET, 307 preserves)', async () => {
    stubRoutes({ 'https://p.test/': { status: 303, to: 'https://p.test/done' } });
    await safeFetch('https://p.test/', { method: 'POST', body: 'payload' });
    expect(seen[1].method).toBe('GET');
    expect(seen[1].body).toBeNull();

    stubRoutes({ 'https://q.test/': { status: 307, to: 'https://q.test/done' } });
    await safeFetch('https://q.test/', { method: 'POST', body: 'payload' });
    expect(seen[1].method).toBe('POST');
    expect(seen[1].body).toBe('payload');
  });

  it('caps a redirect loop instead of spinning forever', async () => {
    stubRoutes({ 'https://a.test/': { status: 302, to: 'https://a.test/' } });
    await expect(safeFetch('https://a.test/')).rejects.toThrow(/too many redirects/);
  });

  it('returns a 3xx that carries no Location rather than inventing a destination', async () => {
    stubRoutes({});
    globalThis.fetch = async () => new Response(null, { status: 302 });
    const res = await safeFetch('https://a.test/');
    expect(res.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// DNS resolution checking (2026-08-04)
//
// net-guard performed NO resolution until now, so a public-looking hostname
// whose A record points at 127.0.0.1 or 169.254.169.254 passed every check.
// The module's own scope note disclosed this rather than hiding it, and it
// survived two earlier rounds of guard fixes.
//
// These tests inject a fake DNS module instead of resolving for real: the
// suite must not depend on a network, on a third-party name continuing to
// resolve the way it does today, or on running online at all. The real-DNS
// path was verified live separately -- `safeFetch('http://localtest.me/')`,
// a genuine public hostname that resolves to loopback, is blocked with
// "resolves to ::1", and public names still pass.
// ---------------------------------------------------------------------------
describe('DNS-based SSRF blocking', () => {
  const fakeDns = (map) => ({
    lookup: async (host) => {
      const v = map[host];
      if (!v) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; }
      if (v instanceof Error) throw v;
      return v;
    },
  });

  afterEach(() => {
    // Back to the real lazy import so no later test sees a stubbed module.
    _setDnsModuleForTests(undefined);
  });

  it('blocks a public hostname that resolves to loopback', async () => {
    _setDnsModuleForTests(fakeDns({ 'evil.example': [{ address: '127.0.0.1', family: 4 }] }));
    await expect(assertPublicDns('evil.example')).rejects.toThrow(/resolves to 127\.0\.0\.1/);
  });

  it('blocks a hostname that resolves to the cloud metadata address', async () => {
    _setDnsModuleForTests(fakeDns({ 'meta.example': [{ address: '169.254.169.254', family: 4 }] }));
    await expect(assertPublicDns('meta.example')).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('blocks a hostname that resolves to an RFC1918 address', async () => {
    _setDnsModuleForTests(fakeDns({ 'lan.example': [{ address: '10.0.0.5', family: 4 }] }));
    await expect(assertPublicDns('lan.example')).rejects.toThrow(/blocked internal destination/);
  });

  it('blocks an IPv6 loopback result', async () => {
    _setDnsModuleForTests(fakeDns({ 'six.example': [{ address: '::1', family: 6 }] }));
    await expect(assertPublicDns('six.example')).rejects.toThrow(/resolves to ::1/);
  });

  it('blocks a unique-local IPv6 result', async () => {
    _setDnsModuleForTests(fakeDns({ 'ula.example': [{ address: 'fd00::1', family: 6 }] }));
    await expect(assertPublicDns('ula.example')).rejects.toThrow(/blocked internal destination/);
  });

  // The interesting case: checking only the first address is exactly how this
  // gets slipped past, so every returned address must face the rule.
  it('blocks when only ONE of several addresses is internal', async () => {
    _setDnsModuleForTests(fakeDns({
      'mixed.example': [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }));
    await expect(assertPublicDns('mixed.example')).rejects.toThrow(/resolves to 127\.0\.0\.1/);
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    _setDnsModuleForTests(fakeDns({ 'good.example': [{ address: '93.184.216.34', family: 4 }] }));
    await expect(assertPublicDns('good.example')).resolves.toBeUndefined();
  });

  it('does not resolve an IP literal, which the literal check already covered', async () => {
    _setDnsModuleForTests({ lookup: async () => { throw new Error('should not be called'); } });
    await expect(assertPublicDns('93.184.216.34')).resolves.toBeUndefined();
    await expect(assertPublicDns('2606:4700::1')).resolves.toBeUndefined();
  });

  // A name that does not resolve is fetch's problem to report. Masking it as
  // an SSRF block would send someone hunting a security bug that isn't there.
  it('passes an unresolvable name through instead of reporting a block', async () => {
    _setDnsModuleForTests(fakeDns({}));
    await expect(assertPublicDns('nope.invalid')).resolves.toBeUndefined();
  });

  it('propagates an unexpected resolver error rather than swallowing it', async () => {
    const boom = new Error('resolver exploded');
    boom.code = 'ESERVFAIL';
    _setDnsModuleForTests(fakeDns({ 'x.example': boom }));
    await expect(assertPublicDns('x.example')).rejects.toThrow(/resolver exploded/);
  });

  // Deliberate fail-open on THIS check only: failing closed would make
  // net-guard block every outbound request on Cloudflare Workers, which has
  // no node:dns at all -- an outage rather than a hardening.
  it('skips the check on a runtime with no DNS module', async () => {
    _setDnsModuleForTests(null);
    await expect(assertPublicDns('evil.example')).resolves.toBeUndefined();
  });

  it('still blocks IP literals when the DNS module is unavailable', () => {
    _setDnsModuleForTests(null);
    expect(() => assertPublicUrl('http://127.0.0.1/')).toThrow(/blocked internal destination/);
    expect(() => assertPublicUrl('http://[::ffff:169.254.169.254]/')).toThrow(/blocked internal destination/);
  });

  it('applies the DNS check inside safeFetch, not only when called directly', async () => {
    _setDnsModuleForTests(fakeDns({ 'sneaky.example': [{ address: '192.168.1.1', family: 4 }] }));
    await expect(safeFetch('http://sneaky.example/data')).rejects.toThrow(/resolves to 192\.168\.1\.1/);
  });
});
