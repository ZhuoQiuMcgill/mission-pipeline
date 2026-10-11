// The reference-semantics scenarios (evaluator-semantics.test.ts: design v30
// 5.2-5.3, 5.6, 8.1) on the stored labels of a project memory (4.1 §4.1): every
// assertion reads the stored state, checked equal to fullCompute first.

process.env['MP_LABELS_STORED'] = '1';
await import('./evaluator-semantics.test.ts');
