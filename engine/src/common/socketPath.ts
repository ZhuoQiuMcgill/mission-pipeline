// Unix domain socket paths are limited to 107 bytes (sun_path is 108 bytes with its NUL). A
// longer path is truncated by the kernel or makes Node fail with a misleading error
// (EADDRINUSE when two truncated paths collide), so every place that builds one checks it.

export const MAX_SOCKET_PATH_BYTES = 107;

/** Null when `path` fits; else the reason, naming the path and its length. */
export function socketPathProblem(path: string): string | null {
  const n = Buffer.byteLength(path, 'utf8');
  return n <= MAX_SOCKET_PATH_BYTES ? null : `the Unix socket path ${path} is ${n} bytes; at most ${MAX_SOCKET_PATH_BYTES} are allowed`;
}

/** Throws with a clear message when `path` does not fit; returns it otherwise. */
export function checkSocketPath(path: string, hint = 'use a shorter directory'): string {
  const p = socketPathProblem(path);
  if (p !== null) throw new Error(`${p}: ${hint}`);
  return path;
}
