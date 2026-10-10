// The reading investigation's web access (design 7.1 "阅读调查的网页抓取由程序在沙箱外按放行名单
// 代为执行", 4.3 "阅读调查可按卡联网"): the seat host fetches, outside the tool sandbox, only the
// addresses the card allows, with size and time caps. The sandbox itself never has a network.
//
// Allowance: each card entry is a URL (an entry without a scheme means https://). A request is
// allowed when it is http(s), carries no credentials, has the entry's origin (scheme, host,
// port), and its path is the entry's path or below it (at a path-segment boundary, or under an
// entry path ending in "/"); an entry with a query string allows only that exact query.
// Redirects are followed by hand, each target checked the same way (at most maxRedirects).
//
// Addresses: the host name is resolved once and the connection is pinned to that address (no
// second lookup between the check and the connection). An address that is not public
// (loopback, private, link-local, carrier-grade NAT, multicast, reserved, IPv4-mapped) is
// refused, whatever the allowance says: the program fetches from the user's machine and must
// not reach its local services (the metering proxy, the ledger's neighbours) through a name
// the card allows. Tests set allowPrivate to fetch from a local server.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const WEB_DEFAULTS = {
  /** Bytes kept of one response body; the rest is cut (the record says so). */
  maxBytes: 2 * 1024 * 1024,
  /** The whole fetch (lookup, connection, redirects, body). */
  timeoutMs: 30_000,
  maxRedirects: 5,
  maxUrlLength: 2048,
} as const;

export interface WebRule {
  readonly entry: string;
  readonly origin: string;
  readonly path: string;
  readonly search: string;
}

export interface WebAllowance {
  readonly rules: readonly WebRule[];
  /** Card entries that are not usable addresses (ignored). */
  readonly invalid: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

function parseEntry(entry: string): WebRule | null {
  const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '' || u.hostname === '') return null;
  return { entry, origin: u.origin, path: u.pathname, search: u.search };
}

export function webAllowance(network: { readonly allowed: readonly string[]; readonly maxBytes?: number; readonly timeoutMs?: number } | undefined): WebAllowance {
  const rules: WebRule[] = [];
  const invalid: string[] = [];
  for (const e of network?.allowed ?? []) {
    const r = parseEntry(e.trim());
    if (r === null) invalid.push(e);
    else rules.push(r);
  }
  return {
    rules,
    invalid,
    maxBytes: network?.maxBytes ?? WEB_DEFAULTS.maxBytes,
    timeoutMs: network?.timeoutMs ?? WEB_DEFAULTS.timeoutMs,
    maxRedirects: WEB_DEFAULTS.maxRedirects,
  };
}

/** The rule that allows `u`, or null. */
export function allowedBy(a: WebAllowance, u: URL): WebRule | null {
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') return null;
  for (const r of a.rules) {
    if (u.origin !== r.origin) continue;
    const below = r.path.endsWith('/') ? u.pathname.startsWith(r.path) : u.pathname === r.path || u.pathname.startsWith(`${r.path}/`);
    if (!below) continue;
    if (r.search !== '' && u.search !== r.search) continue;
    return r;
  }
  return null;
}

const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

/** A routable public address (not loopback, private, link-local, reserved, multicast or mapped). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d, ::ffff:xxxx:xxxx) is never fetched (a BlockList rule for it
  // would also match every IPv4 address)
  if (family === 6 && /^(0{0,4}:){0,5}:?ffff:/i.test(address.replace(/^::/, '0::'))) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type FetchOutcome =
  | {
      readonly kind: 'fetched';
      readonly url: string;
      readonly finalUrl: string;
      readonly redirects: readonly string[];
      readonly status: number;
      readonly contentType: string | null;
      readonly contentEncoding: string | null;
      readonly address: string;
      readonly body: Buffer;
      /** The body was longer than maxBytes and is cut there. */
      readonly truncated: boolean;
      readonly ms: number;
    }
  /** Not allowed (the card's allowance, a redirect outside it, a non-public address): a WI notice. */
  | { readonly kind: 'refused'; readonly url: string; readonly reason: string }
  /** Allowed, but the fetch did not succeed (lookup, connection, timeout): the seat is told, no notice. */
  | { readonly kind: 'failed'; readonly url: string; readonly reason: string };

export interface FetchOptions {
  /** Tests only: also fetch from loopback and private addresses. */
  readonly allowPrivate?: boolean;
  readonly signal?: AbortSignal;
  /** Name resolution (default: the system resolver, every address). */
  readonly resolve?: (host: string) => Promise<readonly { readonly address: string; readonly family: number }[]>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function resolveHost(host: string, o: FetchOptions): Promise<{ address: string; family: number } | { refused: string } | { failed: string }> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  let all: readonly { address: string; family: number }[];
  if (isIP(bare) !== 0) all = [{ address: bare, family: isIP(bare) }];
  else {
    try {
      all = o.resolve !== undefined ? await o.resolve(bare) : await dnsLookup(bare, { all: true, verbatim: true });
    } catch (e) {
      return { failed: `the name ${bare} could not be resolved (${(e as Error).message})` };
    }
  }
  if (all.length === 0) return { failed: `the name ${bare} has no address` };
  if (o.allowPrivate !== true) {
    const local = all.filter((a) => !isPublicAddress(a.address));
    if (local.length > 0) return { refused: `${bare} resolves to a non-public address (${local.map((a) => a.address).join(', ')}); the program never fetches from local or private networks` };
  }
  const first = all[0] as { address: string; family: number };
  return { address: first.address, family: first.family };
}

type Hop = { readonly kind: 'redirect'; readonly location: string; readonly status: number } | Extract<FetchOutcome, { kind: 'fetched' }> | Extract<FetchOutcome, { kind: 'failed' }>;

function requestOnce(u: URL, pinned: { address: string; family: number }, a: WebAllowance, deadline: number, o: FetchOptions, original: string, redirects: readonly string[], t0: number): Promise<Hop> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (h: Hop): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(h);
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        agent: false,
        headers: { 'user-agent': 'mission-pipeline-reader/4.0', accept: '*/*', 'accept-encoding': 'identity' },
        // pinned: the connection goes to the address that was checked, never a second lookup
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (opts?.all === true) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECTS.has(status) && typeof location === 'string' && location !== '') {
          res.resume();
          done({ kind: 'redirect', location, status });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = (): void =>
          done({
            kind: 'fetched',
            url: original,
            finalUrl: u.toString(),
            redirects,
            status,
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
            contentEncoding: typeof res.headers['content-encoding'] === 'string' ? res.headers['content-encoding'] : null,
            address: pinned.address,
            body: Buffer.concat(chunks, size),
            truncated,
            ms: Date.now() - t0,
          });
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          const room = a.maxBytes - size;
          if (c.length > room) {
            if (room > 0) chunks.push(c.subarray(0, room));
            size += Math.max(0, room);
            truncated = true;
            finish();
            res.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        res.on('end', finish);
        res.on('error', (e) => done({ kind: 'failed', url: original, reason: `the response broke off (${e.message})` }));
      },
    );
    const timer = setTimeout(() => {
      done({ kind: 'failed', url: original, reason: `no complete answer within ${a.timeoutMs} ms` });
      req.destroy();
    }, Math.max(1, deadline - Date.now()));
    const onAbort = (): void => {
      done({ kind: 'failed', url: original, reason: 'the seat is being ended' });
      req.destroy();
    };
    if (o.signal?.aborted === true) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => done({ kind: 'failed', url: original, reason: `the request failed (${e.message})` }));
    req.end();
  });
}

/** Fetches one address the allowance allows (following allowed redirects), within the caps. */
export async function fetchAllowed(url: string, a: WebAllowance, o: FetchOptions = {}): Promise<FetchOutcome> {
  const t0 = Date.now();
  const deadline = t0 + a.timeoutMs;
  if (url.length > WEB_DEFAULTS.maxUrlLength) return { kind: 'refused', url: url.slice(0, 200), reason: `the address is longer than ${WEB_DEFAULTS.maxUrlLength} characters` };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'refused', url, reason: 'not an absolute http(s) address' };
  }
  u.hash = '';
  const redirects: string[] = [];
  for (let hop = 0; ; hop++) {
    if (allowedBy(a, u) === null) {
      return {
        kind: 'refused',
        url,
        reason: hop === 0 ? `${u.toString()} is not an address this card allows` : `the page redirects to ${u.toString()}, which this card does not allow`,
      };
    }
    const pinned = await resolveHost(u.hostname, o);
    if ('refused' in pinned) return { kind: 'refused', url, reason: pinned.refused };
    if ('failed' in pinned) return { kind: 'failed', url, reason: pinned.failed };
    if (Date.now() >= deadline) return { kind: 'failed', url, reason: `no complete answer within ${a.timeoutMs} ms` };
    const h = await requestOnce(u, pinned, a, deadline, o, url, [...redirects], t0);
    if (h.kind !== 'redirect') return h;
    if (hop >= a.maxRedirects) return { kind: 'failed', url, reason: `more than ${a.maxRedirects} redirects` };
    let next: URL;
    try {
      next = new URL(h.location, u);
    } catch {
      return { kind: 'failed', url, reason: `HTTP ${h.status} to an unusable address` };
    }
    next.hash = '';
    redirects.push(next.toString());
    u = next;
  }
}

/** Whether a body is shown to the seat as text (else it is recorded but described only). */
export function isTextual(contentType: string | null, body: Buffer): boolean {
  if (contentType !== null) {
    const t = contentType.toLowerCase();
    if (/^text\/|json|xml|javascript|ecmascript|yaml|csv|x-www-form-urlencoded/.test(t)) return true;
    if (/^(image|audio|video|font)\/|octet-stream|zip|pdf|gzip/.test(t)) return false;
  }
  return !body.subarray(0, 8192).includes(0);
}
