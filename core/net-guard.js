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
 * True if the four octets name a loopback / private / link-local /
 * unspecified IPv4 destination. Factored out so the IPv6 path can reuse it
 * for IPv4-mapped and IPv4-compatible addresses, which embed a real IPv4
 * address and route to exactly the same host.
 */
function isInternalIPv4(a, b, c, d) {
  const loopback = a === 127;
  const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const linkLocal = a === 169 && b === 254;
  const unspecified = a === 0 && b === 0 && c === 0 && d === 0;
  const cgnat = a === 100 && b >= 64 && b <= 127; // RFC 6598 shared address space
  return loopback || rfc1918 || linkLocal || unspecified || cgnat;
}

/**
 * Expands an IPv6 literal (already stripped of brackets) into its 8 numeric
 * hextets, or returns null if it isn't parseable as one.
 *
 * SECURITY (2026-08-03, full-codebase audit): the previous check read only
 * `host.split(':')[0]`. For every address written in `::`-compressed form
 * that first element is the EMPTY STRING, so `parseInt('', 16)` produced
 * NaN and every subsequent range check was skipped. Verified live:
 * `[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]` (cloud metadata),
 * `[fd00::1]` and `[fc00::1]` were all ALLOWED by the guard. Note WHATWG
 * `new URL()` normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so
 * matching on the dotted form alone would not have been enough either --
 * this works on the expanded numeric form instead.
 * @param {string} host
 * @returns {number[]|null} 8 hextets, or null
 */
function expandIPv6(host) {
  let s = host;
  // A trailing dotted-quad (IPv4-mapped/compatible, e.g. ::ffff:127.0.0.1)
  // becomes two hextets.
  const v4Tail = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (v4Tail) {
    const o = v4Tail[2].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    s = v4Tail[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const parse = (part) => (part === '' ? [] : part.split(':').map((h) => {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return NaN;
    return parseInt(h, 16);
  }));

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;

  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

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
    if (isInternalIPv4(a, b, c, d)) {
      throw new Error(`net-guard: blocked internal destination: ${host}`);
    }
    return parsed;
  }

  // IPv6 literal
  if (host.includes(':')) {
    const groups = expandIPv6(host.toLowerCase());
    if (!groups) {
      throw new Error(`net-guard: invalid IPv6: ${host}`);
    }

    const allZeroPrefix = (n) => groups.slice(0, n).every((g) => g === 0);

    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): these carry a
    // real IPv4 address in the last two hextets and route to that host, so
    // they must face the exact same checks the IPv4 branch applies -- this
    // is the hole that let `[::ffff:169.254.169.254]` (cloud metadata) and
    // `[::ffff:127.0.0.1]` straight through.
    if (allZeroPrefix(5) && (groups[5] === 0xffff || groups[5] === 0)) {
      const a = groups[6] >> 8, b = groups[6] & 0xff;
      const c = groups[7] >> 8, d = groups[7] & 0xff;
      // ::/128 (unspecified) and ::1/128 (loopback) fall out of this too.
      if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) {
        throw new Error(`net-guard: blocked internal destination: ${host}`);
      }
      if (isInternalIPv4(a, b, c, d)) {
        throw new Error(`net-guard: blocked internal destination: ${host}`);
      }
    }

    // Link-local fe80::/10
    if ((groups[0] & 0xffc0) === 0xfe80) {
      throw new Error(`net-guard: blocked internal destination: ${host}`);
    }
    // Unique-local fc00::/7 (fc00:: and fd00::) — the IPv6 equivalent of
    // RFC1918, entirely unchecked before.
    if ((groups[0] & 0xfe00) === 0xfc00) {
      throw new Error(`net-guard: blocked internal destination: ${host}`);
    }
  }

  return parsed;
}