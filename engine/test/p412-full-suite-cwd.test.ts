// 4.1.2 final review r2: a full-suite command is matched by its text AND its working directory. In a
// repository with packages, `npm test` at the root (the suite) and `npm test` in frontend/ (a local
// test) are different commands: the local one runs at hand-back and passes rule 7.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFullSuiteCommand } from '../src/common/fullSuite.ts';
import { verificationCommands } from '../src/process/actions.ts';

const suite = [{ id: 'all', command: 'npm test' }];

test('the same text in another working directory is not the full suite', () => {
  assert.equal(isFullSuiteCommand(suite, 'npm test'), true, 'root npm test is the suite');
  assert.equal(isFullSuiteCommand(suite, 'npm  test', './'), true, 'normalized text and directory');
  assert.equal(isFullSuiteCommand(suite, 'npm test', 'frontend'), false, 'frontend/ npm test is a local test');
  assert.equal(isFullSuiteCommand([{ id: 'fe', command: 'npm test', cwd: 'frontend/' }], 'npm test', './frontend'), true);
});

test('the hand-back keeps a package-local command whose text equals the suite', () => {
  const kept = verificationCommands(suite, [{ id: 'fe', command: 'npm test', cwd: 'frontend' }, { id: 'all', command: 'npm test' }]);
  assert.deepEqual(kept.map((c) => c.id), ['fe']);
});
