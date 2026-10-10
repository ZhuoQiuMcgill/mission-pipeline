// Fault injection into a REAL unit supervisor (src/exec/supervisor-main.ts), for the §14 item 9
// windows: kill or pause it at an exact point of writing its proof file. Preloaded with
// `node --import <this file>` by a wrapper used as the supervisor's node binary (see
// launchUnitSupervisor's nodePath). Not a test file.
//
// The supervisor writes its proof with writeFileAtomic (src/common/fsx.ts): open the tmp file
// ('wx'), write, fsync, close, rename to proofs/<launch>.json, open the directory, fsync it.
// This hook patches node:fs (and syncs the ESM named exports) to act at:
//   before-tmp     before the tmp file is created        -> no proof anywhere
//   after-tmp      after the tmp file is written, before the rename -> only a dot tmp file
//   after-rename   after the rename, before the directory fsync     -> a complete proof file
//   after-dirsync  after the directory fsync                       -> a complete, durable proof file
// Action: 'kill' (SIGKILL itself) or 'pause' (block forever; the scheduler's deadline kills it).
// The point is read from <stateDir>/inject/<launch>.json when the proof is being written (so a
// test can choose it after the launch id is known), and only that launch is affected.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';

const configPath = process.argv[process.argv.length - 1];
let stateDir = null;
let launch = null;
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  stateDir = cfg.stateDir;
  launch = cfg.launch;
} catch {
  stateDir = null;
}

if (stateDir !== null && launch !== null) {
  let cached;
  const planOf = () => {
    if (cached !== undefined) return cached;
    try {
      cached = JSON.parse(fs.readFileSync(join(stateDir, 'inject', `${launch}.json`), 'utf8'));
      return cached;
    } catch {
      return { point: 'none', mode: 'none' };
    }
  };
  const proofs = join(stateDir, 'proofs');
  const proofPath = join(proofs, `${launch}.json`);
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const act = (where) => {
    try {
      fs.writeFileSync(join(stateDir, 'inject', `${launch}.${where}`), String(process.pid));
    } catch {
      /* marker only */
    }
    if (planOf().mode === 'pause') for (;;) Atomics.wait(sab, 0, 0, 1000);
    process.kill(process.pid, 'SIGKILL');
  };
  const realOpen = fs.openSync;
  const realRename = fs.renameSync;
  const realFsync = fs.fsyncSync;
  let renamed = false;
  fs.openSync = function (path, flags, mode) {
    if (typeof path === 'string' && dirname(path) === proofs && basename(path).startsWith(`.${launch}.json.`) && planOf().point === 'before-tmp') act('before-tmp');
    return realOpen.call(fs, path, flags, mode);
  };
  fs.renameSync = function (src, dst) {
    if (dst === proofPath && planOf().point === 'after-tmp') act('after-tmp');
    const r = realRename.call(fs, src, dst);
    if (dst === proofPath) {
      renamed = true;
      if (planOf().point === 'after-rename') act('after-rename');
    }
    return r;
  };
  fs.fsyncSync = function (fd) {
    const r = realFsync.call(fs, fd);
    if (renamed && planOf().point === 'after-dirsync') {
      renamed = false;
      act('after-dirsync');
    }
    return r;
  };
  syncBuiltinESMExports();
}
