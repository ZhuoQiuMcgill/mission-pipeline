// The login a seat's Claude Code process uses (design 7.1 "凭据只在 Claude Code 进程里", 9.3:
// "无 API 密钥时走订阅额度"). The process runs in its enclosure with its own config directory,
// so the login is copied into that directory's seed:
//  - subscription: ONLY the claudeAiOauth entry of the user's credentials file, never the
//    other tokens it holds (plugin and MCP connector logins);
//  - api-key: the key goes into the Claude Code process's environment and nowhere else.
// The tool sandbox never sees either (it mounts neither the user's home nor the enclosure).
//
// Refresh hazard: a seat that refreshed the OAuth token would rotate the refresh token in its
// own copy, and the user's session, still holding the old one, would be logged out at its next
// refresh. So the seat's copy carries NO refresh token (it cannot refresh at all), and a seat
// starts only while the access token outlives it (minLifetimeMs); a token that expires inside
// the seat fails its requests (an environment failure) instead of touching the user's login.
// After the seat, a changed token is still reported.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SeatCredentialsSpec =
  | { readonly kind: 'subscription'; readonly source: string; readonly minLifetimeMs: number }
  | { readonly kind: 'api-key'; readonly variable: string }
  /** Tests against a fake model service. */
  | { readonly kind: 'fake-api-key'; readonly key: string };

export class CredentialsUnusable extends Error {
  override readonly name = 'CredentialsUnusable';
}

interface OauthEntry {
  readonly accessToken?: unknown;
  readonly expiresAt?: unknown;
  readonly [k: string]: unknown;
}

export interface PreparedCredentials {
  /** Variables for the Claude Code process (an API key), if any. */
  readonly env: Readonly<Record<string, string>>;
  /** The seed's credentials file, if one was written. */
  readonly seedFile: string | null;
  /** The access token's expiry (ms since epoch), subscription only. */
  readonly expiresAt: number | null;
}

/** Writes the seat's login into `seedDir` (the enclosure's config seed) or returns its environment. */
export function prepareCredentials(spec: SeatCredentialsSpec, seedDir: string, now: number = Date.now()): PreparedCredentials {
  switch (spec.kind) {
    case 'fake-api-key':
      return { env: { ANTHROPIC_API_KEY: spec.key }, seedFile: null, expiresAt: null };
    case 'api-key': {
      const v = process.env[spec.variable];
      if (v === undefined || v === '') throw new CredentialsUnusable(`environment variable ${spec.variable} is not set`);
      return { env: { ANTHROPIC_API_KEY: v }, seedFile: null, expiresAt: null };
    }
    case 'subscription': {
      let all: { claudeAiOauth?: OauthEntry };
      try {
        all = JSON.parse(readFileSync(spec.source, 'utf8')) as typeof all;
      } catch (e) {
        throw new CredentialsUnusable(`cannot read the login at ${spec.source}: ${(e as Error).message}`);
      }
      const oauth = all.claudeAiOauth;
      if (oauth === undefined || typeof oauth.accessToken !== 'string') throw new CredentialsUnusable('no Claude subscription login (claudeAiOauth) in the credentials file');
      const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
      if (expiresAt === null || expiresAt - now < spec.minLifetimeMs) {
        const left = expiresAt === null ? 'unknown' : `${Math.round((expiresAt - now) / 60000)} min`;
        throw new CredentialsUnusable(
          `the login token expires too soon (${left} left, ${Math.round(spec.minLifetimeMs / 60000)} min needed); use Claude Code once in your own session to refresh it`,
        );
      }
      const { refreshToken: _r, refreshTokenExpiresAt: _re, ...accessOnly } = oauth;
      const seedFile = join(seedDir, '.credentials.json');
      writeFileSync(seedFile, JSON.stringify({ claudeAiOauth: accessOnly }), { mode: 0o600 });
      chmodSync(seedFile, 0o600);
      return { env: {}, seedFile, expiresAt };
    }
  }
}

/** True when the seat's copy of the login differs from what it was given (a refresh happened inside). */
export function loginChanged(seedFile: string | null, finalCopy: string | null): boolean {
  if (seedFile === null || finalCopy === null) return false;
  try {
    return loginTextChanged(readFileSync(seedFile, 'utf8'), finalCopy);
  } catch {
    return false;
  }
}

/** loginChanged with the seed's text kept in memory (the seed file is deleted as soon as the enclosure holds its copy). */
export function loginTextChanged(seedText: string | null, finalCopy: string | null): boolean {
  if (seedText === null || finalCopy === null) return false;
  try {
    const a = JSON.parse(seedText) as { claudeAiOauth?: OauthEntry };
    const b = JSON.parse(finalCopy) as { claudeAiOauth?: OauthEntry };
    return a.claudeAiOauth?.accessToken !== b.claudeAiOauth?.accessToken;
  } catch {
    return false;
  }
}
