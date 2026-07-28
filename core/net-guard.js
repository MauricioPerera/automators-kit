/**
 * Network guard — SSRF mitigation.
 *
 * Rejects URLs whose destination is a loopback / private / link-local address
 * BEFORE a fetch is performed. A workflow definition is not necessarily
 * trusted, so any URL it controls must be validated to stop the server from
 * reaching cloud metadata endpoints (169.254.169.254) or internal services.
 *
 * Scope note: this validates the hostname / IP *literal* found in the URL. It
 * does NOT perform DNS resolution, so a public-looking hostname that resolves
 * to a private IP is not caught here. Real DNS-based blocking (resolve then
 * check) is a future improvement, intentionally out of scope for this fix.
 */

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Asserts that a URL points at a public destination. Throws on internal /
 * non-http(s) destinations. Returns the parsed URL on success.
 * @param {string} rawUrl
 * @returns {URL}
 */
export function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`net-guard: invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`net-guard: blocked scheme ${parsed.protocol} (only http/https)`);
  }

  // Strip surrounding brackets from IPv6 literals as exposed by URL.hostname.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (!host) {
    throw new Error('net-guard: URL has no hostname');
  }

  if (host.toLowerCase() === 'localhost') {
    throw new Error(`net-guard: blocked internal destination: ${host}`);
  }

  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = +v4[1], b = +v4[2], c = +v4[3], d = +v4[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) {
      throw new Error(`net-guard: invalid IPv4: ${host}`);
    }
    const loopback = a === 127;
    const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    const linkLocal = a === 169 && b === 254;
    const unspecified = a === 0 && b === 0 && c === 0 && d === 0;
    if (loopback || rfc1918 || linkLocal || unspecified) {
      throw new Error(`net-guard: blocked internal destination: ${host}`);
    }
    return parsed;
  }

  // IPv6 literal
  if (host.includes(':')) {
    const lower = host.toLowerCase();
    // Loopback (::1) and unspecified (::)
    if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') {
      throw new Error(`net-guard: blocked internal destination: ${host}`);
    }
    // Link-local fe80::/10 — first hextet in [0xfe80, 0xfebf]
    const first = lower.split(':')[0];
    const firstVal = parseInt(first, 16);
    if (!Number.isNaN(firstVal) && firstVal >= 0xfe80 && firstVal <= 0xfebf) {
      throw new Error(`net-guard: blocked internal destination: ${host}`);
    }
  }

  return parsed;
}