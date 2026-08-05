/**
 * Network guard — SSRF mitigation.
 *
 * Rejects URLs whose destination is a loopback / private / link-local address
 * BEFORE a fetch is performed. A workflow definition is not necessarily
 * trusted, so any URL it controls must be validated to stop the server from
 * reaching cloud metadata endpoints (169.254.169.254) or internal services.
 *
 * Scope note (updated 2026-08-04, when DNS checking was added -- the previous
 * version of this note said no resolution was performed at all):
 *
 *  - `assertPublicUrl` validates the hostname / IP *literal* in the URL and is
 *    synchronous. On its own it still catches nothing about where a NAME
 *    points.
 *  - `assertPublicDns` resolves a hostname and rejects it if ANY address it
 *    resolves to is internal. `safeFetch` calls it for the initial URL and for
 *    every redirect hop, so all real outbound traffic is covered.
 *  - **DNS rebinding is still NOT covered**, and this is a genuine remaining
 *    hole rather than an oversight: the check resolves the name, then hands
 *    the NAME to `fetch`, which resolves again on its own. A 0-TTL record
 *    answering public-then-private defeats it. Closing that requires
 *    connecting to the verified IP with a `Host` header and a TLS SNI
 *    override, which is not reachable portably with zero dependencies across
 *    Bun, Deno and Node.
 *  - On a runtime with no `node:dns` (Cloudflare Workers), the DNS check is
 *    skipped and behaviour matches the pre-2026-08-04 guard. Literal checks
 *    still apply everywhere. See `assertPublicDns` for why that fails open.
 *
 * Redirects ARE covered, but only for callers that use `safeFetch` below --
 * `assertPublicUrl` alone validates a single URL and cannot see where the
 * server later points you (see `safeFetch`'s own comment).
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

  assertPublicLiteral(host);

  return parsed;
}

/**
 * Throws if `host` is an IP literal pointing at an internal destination.
 * A no-op for anything that is not an IP literal.
 *
 * Extracted from assertPublicUrl (2026-08-04) so the DNS check below can run
 * RESOLVED addresses through the exact same rule. Writing a second copy of
 * "is this address internal" for the DNS path is the mistake this codebase
 * has now made four times over (see Known Security Gaps items 31-36): the
 * copy always ends up weaker than the original, and nobody notices because
 * both read correctly in isolation.
 *
 * @param {string} host  IP literal or hostname, IPv6 already unbracketed
 */
function assertPublicLiteral(host) {
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
    return;
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
}

// DNS module handle: `undefined` = not attempted, `null` = unavailable here.
// Resolved lazily and cached, never imported at module load, because
// `node:dns` does not exist on every runtime this codebase targets --
// Cloudflare Workers has no DNS module at all, and a static import would
// break `net-guard` (and therefore every outbound call) on a supported
// platform rather than protecting it.
let _dnsPromises;

async function _getDns() {
  if (_dnsPromises !== undefined) return _dnsPromises;
  try {
    _dnsPromises = await import('node:dns/promises');
  } catch {
    _dnsPromises = null;
  }
  return _dnsPromises;
}

/** Test seam: force the DNS module (or `null` to simulate a runtime without one). */
export function _setDnsModuleForTests(mod) {
  _dnsPromises = mod;
}

/**
 * Resolves `host` and throws if ANY address it resolves to is internal.
 *
 * SECURITY (2026-08-04): until now `net-guard` never resolved anything, so a
 * public-looking HOSTNAME whose A record points at 127.0.0.1 or
 * 169.254.169.254 sailed through every check -- the module's original scope
 * note disclosed this rather than hiding it, and it stayed open through two
 * rounds of guard fixes. Every address is checked, not just the first: a name
 * resolving to one public and one private address is exactly how this gets
 * slipped past a first-hit check.
 *
 * TWO LIMITS, STATED PLAINLY BECAUSE THEY ARE NOT OBVIOUS FROM THE CODE:
 *
 * 1. **This does not stop DNS rebinding.** We resolve, check, and then hand
 *    the HOSTNAME to `fetch`, which resolves independently. An attacker
 *    serving a 0-TTL record that answers public on the first lookup and
 *    private on the second still wins. Closing that means connecting to the
 *    verified IP with a `Host` header and a TLS SNI override, which is not
 *    reachable portably with zero dependencies across Bun, Deno and Node.
 *    What this DOES close is the far more common case: a hostname that simply
 *    resolves to a private address.
 *
 * 2. **This adds a DNS lookup that `fetch` then immediately repeats.** Resolve-
 *    then-fetch inherently resolves twice; there is no portable way to hand
 *    `fetch` an already-resolved address. The OS resolver caches, so the
 *    steady-state cost measured here is ~1ms, but the FIRST call to any host
 *    pays a full round-trip — ~800ms was observed against a cold resolver for
 *    a name that does not exist. That is not hypothetical: it made two
 *    poll-trigger example tests flaky the moment this shipped, because their
 *    placeholder host was being resolved for real on every poll. Those tests
 *    now inject a resolver through `_setDnsModuleForTests`. No app-level cache
 *    is added on purpose — caching the result of a security check means a
 *    stale answer can allow a destination the current DNS would refuse, and
 *    the OS resolver already provides the cheap win.
 *
 * 3. **On a runtime with no `node:dns`, the check is skipped**, and behaviour
 *    is exactly what it was before this function existed. That is a
 *    deliberate fail-open on THIS check alone: failing closed would mean
 *    `net-guard` blocks every outbound request on Cloudflare Workers, turning
 *    a hardening step into an outage on a supported platform. The literal-IP
 *    checks still apply everywhere.
 *
 * @param {string} host  hostname or IP literal, IPv6 already unbracketed
 */
export async function assertPublicDns(host) {
  // An IP literal has already faced assertPublicLiteral and needs no lookup.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(':')) return;

  const dns = await _getDns();
  if (!dns) return; // limit 2 above

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (err) {
    // A name that does not resolve is not a guard failure -- let `fetch`
    // produce its own, more accurate error rather than masking it as an SSRF
    // block, which would send someone hunting for a security problem that
    // isn't there.
    if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN' || err?.code === 'ENODATA') return;
    throw err;
  }

  for (const { address } of addresses) {
    try {
      assertPublicLiteral(address);
    } catch {
      throw new Error(
        `net-guard: blocked internal destination: ${host} resolves to ${address}`
      );
    }
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Dropped when a redirect crosses to a different origin, so a workflow's
// credentials are never handed to a host the caller never named.
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * `fetch` with the SSRF guard applied to EVERY hop, not just the first.
 *
 * SECURITY (2026-08-03, full-codebase audit): `assertPublicUrl` validates the
 * URL it is handed and nothing more, while `fetch` defaults to
 * `redirect: 'follow'`. Every outbound call site in this codebase used that
 * default, so a workflow definition pointing at an attacker-controlled PUBLIC
 * host — which the guard happily allows — reached any internal destination
 * the moment that host answered `302 Location: http://127.0.0.1/`. Verified
 * live: the guard blocked the direct attempt and the redirect delivered the
 * same internal body anyway, into the node result.
 *
 * This follows redirects manually so each hop's destination faces the same
 * check as the original URL. Two details that are easy to get wrong and are
 * handled here:
 *  - **Method/body rewriting** matches what `fetch` itself would have done,
 *    so switching to manual following is not a behavior change for ordinary
 *    traffic: 303 always becomes GET; 301/302 turn POST into GET (historical
 *    browser behavior); 307/308 preserve method and body.
 *  - **Credential headers are dropped on a cross-origin hop.** Without this,
 *    following a redirect would forward `Authorization` (which
 *    `core/nodes.js` fills from the credential vault) to whatever host the
 *    redirect names — turning an SSRF probe into credential exfiltration.
 *    Same-origin redirects keep them, since that is the common real case.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ maxRedirects?: number }} [opts]
 * @returns {Promise<Response>} the first non-redirect response
 */
export async function safeFetch(url, init = {}, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = assertPublicUrl(String(url));
  // Hostname resolution is checked HERE rather than inside assertPublicUrl:
  // that function is synchronous and has callers (triggers.js registering a
  // trigger, connector.js, nodes.js) that only validate a URL without ever
  // making the request. Making it async would change every one of their
  // signatures. safeFetch is the single point every actual outbound call
  // funnels through, so the check lands once and covers all of them.
  await assertPublicDns(current.hostname.replace(/^\[|\]$/g, ''));
  let request = { ...init };

  for (let hop = 0; ; hop++) {
    const res = await fetch(current.toString(), { ...request, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get('location');
    // A 3xx with no Location is not actionable -- hand it back rather than
    // inventing a destination.
    if (!location) return res;

    if (hop >= maxRedirects) {
      throw new Error(`net-guard: too many redirects (>${maxRedirects}) starting from ${url}`);
    }

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`net-guard: invalid redirect target '${location}' from ${current}`);
    }
    // The whole point: the hop's destination is validated exactly like the
    // original URL, so an internal target is refused however many public
    // hosts were chained in front of it.
    assertPublicUrl(next.toString());
    // Same reason the literal check is repeated per hop: a redirect to a
    // public-looking name that resolves internally is the identical attack
    // one indirection later.
    await assertPublicDns(next.hostname.replace(/^\[|\]$/g, ''));

    if (next.origin !== current.origin && request.headers) {
      const headers = { ...request.headers };
      for (const key of Object.keys(headers)) {
        if (CREDENTIAL_HEADERS.includes(key.toLowerCase())) delete headers[key];
      }
      request = { ...request, headers };
    }

    const method = (request.method || 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      request = { ...request, method: 'GET' };
      delete request.body;
    }

    current = next;
  }
}
