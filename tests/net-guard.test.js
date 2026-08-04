/**
 * Tests: core/net-guard.js (SSRF guard)
 */

import { describe, it, expect } from 'bun:test';
import { assertPublicUrl } from '../core/net-guard.js';

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
