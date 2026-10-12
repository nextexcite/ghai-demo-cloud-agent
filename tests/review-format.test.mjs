import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  parseReview,
  renderReview,
  reviewInstructions,
  reviewSchema,
} from '../ops/ci/review-format.mjs';

const diff = [
  'diff --git a/src/ratio.mjs b/src/ratio.mjs',
  'index 1111111..2222222 100644',
  '--- a/src/ratio.mjs',
  '+++ b/src/ratio.mjs',
  '@@ -1,4 +1,4 @@',
  ' export function ratio(a, b) {',
  "-  if (b === 0) throw new Error('zero divisor');",
  "+  if (a === 0) throw new Error('zero divisor');",
  '   return a / b;',
  ' }',
  '',
].join('\n');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const finding = (changes = {}) => ({
  path: 'src/ratio.mjs',
  line: 2,
  severity: 'HIGH',
  explanation: 'A zero divisor is accepted, so ratio(1, 0) returns Infinity.',
  fix: 'Check b instead of a and test both zero-divisor and zero-numerator cases.',
  ...changes,
});
const review = (changes = {}) => ({
  summary: 'The changed guard checks the numerator instead of the divisor.',
  verdict: 'BLOCK',
  findings: [finding()],
  ...changes,
});
const provenance = (changes = {}) => ({
  repository: 'synthetic/demo',
  workflowSha: 'c'.repeat(40),
  pr: 7,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  diffSha256: hash(diff),
  diffBytes: Buffer.byteLength(diff),
  ...changes,
});
const parse = (value, patch = diff) =>
  parseReview(JSON.stringify(value), patch);
const oneLine = (path = 'src/one.mjs') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

// The service schema is a request aid; local validation always remains decisive.
test('exports strict structured-output schema and complete review instructions', () => {
  assert.equal(reviewSchema.type, 'object');
  assert.equal(reviewSchema.additionalProperties, false);
  assert.deepEqual([...reviewSchema.required].sort(), [
    'findings',
    'summary',
    'verdict',
  ]);
  assert.equal(
    reviewSchema.properties.findings.items.additionalProperties,
    false,
  );
  assert.equal(reviewSchema.properties.findings.maxItems, 12);
  assert.deepEqual(reviewSchema.properties.verdict.enum, [
    'BLOCK',
    'OK',
    'OK_WITH_NOTES',
  ]);
  assert.match(reviewInstructions, /untrusted/);
  assert.match(reviewInstructions, /NEW side/);
  assert.match(reviewInstructions, /Never execute code/);
  assert.match(reviewInstructions, /OK_WITH_NOTES/);
});

test('accepts structured blocking, clean, and non-blocking reviews', () => {
  assert.deepEqual(parse(review()), review());
  const clean = review({
    verdict: 'OK',
    findings: [],
    summary: 'No concrete introduced bug is visible.',
  });
  assert.deepEqual(parse(clean), clean);
  const notes = review({
    verdict: 'OK_WITH_NOTES',
    findings: [finding({ severity: 'LOW', line: 3 })],
  });
  assert.deepEqual(parse(notes), notes);
  assert.equal(
    parse(review({ findings: [finding({ severity: 'MEDIUM' })] })).verdict,
    'BLOCK',
  );
});

test('accepts leading/trailing JSON whitespace but no prose, fences, or second value', () => {
  assert.deepEqual(
    parseReview(` \n${JSON.stringify(review())}\r\n`, diff),
    review(),
  );
  for (const text of [
    `\`\`\`json\n${JSON.stringify(review())}\n\`\`\``,
    `Here is the result: ${JSON.stringify(review())}`,
    `${JSON.stringify(review())}\n{}`,
    `${JSON.stringify(review())}\nVerdict: BLOCK`,
    '\ufeff' + JSON.stringify(review()),
    '{"summary":"bad",}',
    '{"summary":NaN}',
    '',
  ])
    assert.throws(() => parseReview(text, diff));
});

test('malformed JSON errors do not echo untrusted output', () => {
  assert.throws(
    () => parseReview('synthetic-private-text-is-not-json', diff),
    (error) => error.message === 'Malformed review JSON',
  );
});

test('rejects duplicate JSON keys, including escaped equivalent keys and nested keys', () => {
  for (const text of [
    '{"summary":"one","summary":"two","verdict":"OK","findings":[]}',
    '{"summary":"one","summ\\u0061ry":"two","verdict":"OK","findings":[]}',
    JSON.stringify(review()).replace('"line":2', '"line":2,"line":3'),
    JSON.stringify(review()).replace('"fix":', '"fix":"first","fix":'),
  ])
    assert.throws(() => parseReview(text, diff), /Duplicate JSON key/);
});

test('rejects unexpected or missing root/finding fields and incorrect object types', () => {
  for (const value of [
    null,
    [],
    'text',
    true,
    3,
    { ...review(), extra: 'ignored?' },
    { summary: 'Missing fields' },
    review({ findings: {} }),
    review({ findings: [null] }),
    review({ findings: [finding({ title: 'unsupported' })] }),
    review({
      findings: [
        {
          path: 'src/ratio.mjs',
          line: 2,
          severity: 'HIGH',
          explanation: 'No fix',
        },
      ],
    }),
    JSON.parse('{"__proto__":{},"summary":"one","verdict":"OK","findings":[]}'),
  ])
    assert.throws(() => parse(value));
});

test('rejects verdict/severity mismatches and unsupported enums', () => {
  for (const value of [
    review({ verdict: 'OK' }),
    review({ verdict: 'OK_WITH_NOTES' }),
    review({ verdict: 'BLOCK', findings: [] }),
    review({ verdict: 'OK_WITH_NOTES', findings: [] }),
    review({ findings: [finding({ severity: 'LOW' })] }),
    review({ verdict: 'ok' }),
    review({ verdict: 'OK with notes' }),
    review({ findings: [finding({ severity: 'high' })] }),
    review({ findings: [finding({ severity: 'CRITICAL' })] }),
    review({ findings: [finding({ severity: 1 })] }),
  ])
    assert.throws(() => parse(value));
});

test('rejects malformed line references and only accepts displayed new-side lines', () => {
  for (const line of [0, -1, 1.5, 1e10, '2', '2-3', 'L2', null, true, 5]) {
    assert.throws(() => parse(review({ findings: [finding({ line })] })));
  }
  for (const path of [
    'src/missing.mjs',
    'a/src/ratio.mjs',
    'b/src/ratio.mjs',
  ]) {
    assert.throws(() => parse(review({ findings: [finding({ path })] })));
  }
  // Context is displayed on the new side and is a legitimate anchor.
  assert.equal(
    parse(review({ findings: [finding({ line: 1 })] })).findings[0].line,
    1,
  );
});

test('bounds JSON, string sizes, finding count, and recursive complexity', () => {
  assert.throws(() => parseReview(' '.repeat(65537), diff));
  assert.throws(
    () => parseReview('['.repeat(10) + '0' + ']'.repeat(10), diff),
    /too complex/,
  );
  assert.throws(() => parse(review({ summary: 's'.repeat(1201) })));
  assert.throws(() =>
    parse(review({ findings: [finding({ explanation: 'e'.repeat(1601) })] })),
  );
  assert.throws(() =>
    parse(review({ findings: [finding({ fix: 'f'.repeat(1201) })] })),
  );
  assert.throws(() =>
    parse(
      review({
        findings: Array.from({ length: 13 }, (_, i) =>
          finding({ explanation: `Issue ${i}` }),
        ),
      }),
    ),
  );
  for (const value of ['', ' \r\n\t', false, 12, [], {}]) {
    assert.throws(() => parse(review({ summary: value })));
    assert.throws(() =>
      parse(review({ findings: [finding({ explanation: value })] })),
    );
    assert.throws(() => parse(review({ findings: [finding({ fix: value })] })));
  }
});

test('rejects unsafe controls, bidi controls, and unpaired Unicode surrogates', () => {
  for (const value of [
    'a\0b',
    'a\u001bb',
    'a\u007fb',
    'a\u0085b',
    'a\u202eb',
    'a\u2066b',
    'a\u061cb',
    'a\ud800b',
    'a\udc00b',
  ]) {
    assert.throws(() => parse(review({ summary: value })));
    assert.throws(() => renderReview(review({ summary: value }), provenance()));
  }
  assert.equal(
    parse(review({ summary: 'A Unicode note: 🧪 café.' })).summary,
    'A Unicode note: 🧪 café.',
  );
});

test('rejects duplicate findings even when only severity, fix, or whitespace changes', () => {
  for (const duplicate of [
    finding(),
    finding({ fix: 'Another fix.' }),
    finding({ severity: 'MEDIUM' }),
    finding({
      explanation: `  ${finding().explanation.replaceAll(' ', '\r\n')}  `,
    }),
  ])
    assert.throws(
      () => parse(review({ findings: [finding(), duplicate] })),
      /Duplicate finding/,
    );
  assert.equal(
    parse(
      review({
        findings: [
          finding(),
          finding({
            explanation: 'A separate issue on this same displayed line.',
          }),
        ],
      }),
    ).findings.length,
    2,
  );
});

test('maps multiple hunks and files while rejecting undisplayed gaps', () => {
  const patch = [
    'diff --git a/src/first.mjs b/src/first.mjs',
    '--- a/src/first.mjs',
    '+++ b/src/first.mjs',
    '@@ -1,2 +1,3 @@',
    ' context',
    '-old',
    '+new',
    '+extra',
    '@@ -7,2 +8,2 @@ suffix is untrusted data',
    '-old',
    '+new',
    ' context',
    oneLine('src/second.mjs'),
  ].join('\n');
  const value = review({
    findings: [
      finding({ path: 'src/first.mjs', line: 9 }),
      finding({ path: 'src/second.mjs', line: 1 }),
    ],
  });
  assert.equal(parse(value, patch).findings.length, 2);
  for (const line of [4, 5, 7, 10])
    assert.throws(() =>
      parse(
        review({ findings: [finding({ path: 'src/first.mjs', line })] }),
        patch,
      ),
    );
});

test('supports new files, deleted files, and insertion/deletion zero-count hunks', () => {
  const added =
    'diff --git a/src/new.mjs b/src/new.mjs\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/new.mjs\n@@ -0,0 +1,2 @@\n+first\n+second\n';
  assert.equal(
    parse(
      review({ findings: [finding({ path: 'src/new.mjs', line: 2 })] }),
      added,
    ).findings[0].line,
    2,
  );
  const deleted =
    'diff --git a/src/gone.mjs b/src/gone.mjs\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/src/gone.mjs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\n-second\n';
  assert.equal(
    parse(review({ verdict: 'OK', findings: [] }), deleted).verdict,
    'OK',
  );
  assert.throws(() =>
    parse(
      review({ findings: [finding({ path: 'src/gone.mjs', line: 1 })] }),
      deleted,
    ),
  );
  const insertion =
    'diff --git a/src/ratio.mjs b/src/ratio.mjs\n--- a/src/ratio.mjs\n+++ b/src/ratio.mjs\n@@ -4,0 +5,2 @@\n+first\n+second\n';
  assert.equal(
    parse(review({ findings: [finding({ line: 5 })] }), insertion).findings[0]
      .line,
    5,
  );
  const removal =
    'diff --git a/src/ratio.mjs b/src/ratio.mjs\n--- a/src/ratio.mjs\n+++ b/src/ratio.mjs\n@@ -1,4 +1,3 @@\n first\n-removed\n third\n fourth\n';
  assert.throws(() =>
    parse(review({ findings: [finding({ line: 4 })] }), removal),
  );
});

test('supports renamed text files with verified metadata and new-side path only', () => {
  const patch =
    'diff --git a/src/old.mjs b/src/new.mjs\nsimilarity index 50%\nrename from src/old.mjs\nrename to src/new.mjs\nindex 1111111..2222222 100644\n--- a/src/old.mjs\n+++ b/src/new.mjs\n@@ -1 +1 @@\n-old\n+new\n';
  assert.equal(
    parse(
      review({ findings: [finding({ path: 'src/new.mjs', line: 1 })] }),
      patch,
    ).findings[0].path,
    'src/new.mjs',
  );
  assert.throws(() =>
    parse(
      review({ findings: [finding({ path: 'src/old.mjs', line: 1 })] }),
      patch,
    ),
  );
  assert.throws(() =>
    parse(
      review({ verdict: 'OK', findings: [] }),
      patch.replace('rename to src/new.mjs', 'rename to src/other.mjs'),
    ),
  );
});

test('supports valid no-newline markers and rejects malformed EOF markers', () => {
  const patch = oneLine().replace(
    '-old\n+new\n',
    '-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
  );
  assert.equal(
    parse(
      review({ findings: [finding({ path: 'src/one.mjs', line: 1 })] }),
      patch,
    ).verdict,
    'BLOCK',
  );
  for (const malformed of [
    oneLine().replace(
      '@@ -1 +1 @@\n',
      '@@ -1 +1 @@\n\\ No newline at end of file\n',
    ),
    patch + '\\ No newline at end of file\n',
    patch + '@@ -3 +3 @@\n-old\n+new\n',
    oneLine()
      .replace('@@ -1 +1 @@', '@@ -1,2 +1,2 @@')
      .replace('-old\n', '-old\n\\ No newline at end of file\n'),
  ])
    assert.throws(() =>
      parse(review({ verdict: 'OK', findings: [] }), malformed),
    );
});

test('accepts CRLF diffs, rejects bare-CR diffs, empty/oversized diffs, and NUL', () => {
  assert.equal(parse(review(), diff.replaceAll('\n', '\r\n')).verdict, 'BLOCK');
  for (const patch of [
    '',
    '\n',
    'x'.repeat(32769),
    diff.replace('\n', '\r'),
    diff + '\0',
    diff + '\ud800',
  ]) {
    assert.throws(() => parse(review(), patch));
  }
});

test('rejects unsafe paths, quoted/combined/binary/submodule diffs, and metadata-only changes', () => {
  for (const path of [
    '../escape.mjs',
    '/absolute.mjs',
    'a/../b',
    'a/./b',
    'a//b',
    'C:drive',
    'a\\b',
    '.git/config',
    '.GIT/config',
    'name with spaces',
    'name\tfile',
    'a%2fb',
    'x'.repeat(241),
    'a\u202eb',
  ]) {
    assert.throws(() =>
      parse(review({ verdict: 'OK', findings: [] }), oneLine(path)),
    );
    assert.throws(() => parse(review({ findings: [finding({ path })] })));
  }
  for (const patch of [
    'diff --cc src/one.mjs\n@@@ -1 +1 @@@\n+new\n',
    'diff --git "a/file name" "b/file name"\n',
    'diff --git a/a b/a\nindex 1111111..2222222 100644\nBinary files a/a and b/a differ\n',
    oneLine().replace('--- a/', 'index 1111111..2222222 160000\n--- a/'),
    'diff --git a/a b/a\nold mode 100644\nnew mode 100755\n',
  ])
    assert.throws(() => parse(review({ verdict: 'OK', findings: [] }), patch));
});

test('rejects inconsistent file markers, metadata, and duplicate paths', () => {
  for (const patch of [
    diff.replace('--- a/src/ratio.mjs', '--- a/src/other.mjs'),
    diff.replace('+++ b/src/ratio.mjs', '+++ b/src/other.mjs'),
    diff.replace('--- a/src/ratio.mjs', '--- /dev/null'),
    diff.replace('+++ b/src/ratio.mjs', '+++ /dev/null'),
    diff.replace('index ', 'old mode 100644\nindex '),
    diff.replace('index ', 'new file mode 100644\nindex '),
    diff.replace('index ', 'similarity index 50%\nindex '),
    diff.replace('index ', 'rename from src/ratio.mjs\nindex '),
    diff.replace('index ', 'index 3333333..4444444 100644\nindex '),
    diff + diff,
    diff + '\n',
  ])
    assert.throws(() => parse(review(), patch));
});

test('rejects incorrect hunk counts, ordering, unchanged gaps, and impossible ranges', () => {
  for (const range of [
    '@@ -1,5 +1,4 @@',
    '@@ -1,3 +1,4 @@',
    '@@ -1,4 +1,5 @@',
    '@@ -1,4 +1,3 @@',
    '@@ -0,4 +1,4 @@',
    '@@ -1,4 +0,4 @@',
    '@@ -01,4 +1,4 @@',
    '@@ -1,4 +1.5,4 @@',
    '@@ -1,4 +1e2,4 @@',
    '@@ -1,4 +2,4 @@',
    '@@ -0,0 +0,0 @@',
    '@@ -1000000000,4 +1000000000,4 @@',
    '@@ -9007199254740992 +1 @@',
  ])
    assert.throws(() =>
      parse(review(), diff.replace('@@ -1,4 +1,4 @@', range)),
    );
  for (const tail of ['@@ -2 +2 @@\n-a\n+b\n', '@@ -8 +9 @@\n-a\n+b\n']) {
    assert.throws(() => parse(review(), diff + tail));
  }
  assert.throws(() =>
    parse(
      review(),
      diff.replace(
        "-  if (b === 0) throw new Error('zero divisor');\n+  if (a === 0) throw new Error('zero divisor');",
        "   if (b === 0) throw new Error('zero divisor');",
      ),
    ),
  );
});

test('renders an auditable real PR target, immutable revisions, findings, and verdict', () => {
  const markdown = renderReview(parse(review()), provenance());
  assert.match(markdown, /Target: Pull request #7/);
  assert.match(markdown, new RegExp(`Base revision: ${'a'.repeat(40)}`));
  assert.match(markdown, new RegExp(`Head revision: ${'b'.repeat(40)}`));
  assert.match(markdown, /Workflow revision:/);
  assert.match(markdown, /Diff SHA-256:/);
  assert.match(markdown, /## Verdict: BLOCK/);
  assert.match(markdown, /HIGH · src&#47;ratio&#46;mjs:2/);
  assert.match(markdown, /Explanation: A zero divisor/);
  assert.match(markdown, /Suggested fix: Check b/);
  assert.match(markdown, /bounded diff-only review/);
  assert.doesNotMatch(markdown, /Synthetic fixture/);
});

test('prominently labels synthetic fixtures and never implies they reviewed a real PR', () => {
  const fixture = provenance({
    fixture: true,
    fixtureSha256: hash(diff),
    pr: undefined,
    base: undefined,
    head: undefined,
  });
  const markdown = renderReview(parse(review()), fixture);
  assert.match(
    markdown,
    /Target: Synthetic fixture\. This is not a review of a real pull request\./,
  );
  assert.match(markdown, /Fixture SHA-256:/);
  assert.doesNotMatch(
    markdown,
    /Target: Pull request|Base revision:|Head revision:/,
  );
});

test('renders clean results and non-blocking notes with meaningful verdicts', () => {
  const clean = renderReview(
    parse(review({ verdict: 'OK', findings: [] })),
    provenance(),
  );
  assert.match(clean, /## Verdict: OK\n/);
  assert.match(clean, /No findings\./);
  const notes = renderReview(
    parse(
      review({
        verdict: 'OK_WITH_NOTES',
        findings: [finding({ severity: 'LOW' })],
      }),
    ),
    provenance(),
  );
  assert.match(notes, /## Verdict: OK_WITH_NOTES/);
  assert.match(notes, /LOW ·/);
});

test('renders untrusted HTML, links, mentions, fences, and CR/LF as inert text', () => {
  const attack =
    '<img src=x onerror=alert(1)> [link](https://example.invalid) ![image](x) <https://example.invalid> @someone\r\n```\r# injected\n~~~\t&copy; <!-- comment -->';
  const malicious = review({
    summary: attack,
    findings: [finding({ explanation: attack, fix: attack })],
  });
  const markdown = renderReview(parse(malicious), provenance());
  assert.doesNotMatch(markdown, /<|>|\[|\]|`|~|https:\/\/|@someone|\r|\t/);
  assert.doesNotMatch(markdown, /^# injected/m);
  assert.match(markdown, /&#60;img/);
  assert.match(
    markdown,
    /&#91;link&#93;&#40;https&#58;&#47;&#47;example&#46;invalid&#41;/,
  );
  assert.match(markdown, /&#64;someone &#96;&#96;&#96; &#35; injected/);
  assert.match(markdown, /&#38;copy&#59;/);
});

test('ignores transport identifiers and rejects incomplete or ambiguous provenance', () => {
  const markdown = renderReview(
    review(),
    provenance({
      model: 'synthetic-private-model',
      endpoint: 'https://synthetic.invalid/v1',
      other: '<script>',
    }),
  );
  assert.doesNotMatch(
    markdown,
    /synthetic-private-model|synthetic\.invalid|script|endpoint|model/,
  );
  for (const changes of [
    { repository: 'invalid' },
    { repository: 'owner/repo\n# forged' },
    { workflowSha: 'main' },
    { head: 'feature' },
    { base: 'a'.repeat(39) },
    { pr: 0 },
    { pr: '7' },
    { diffBytes: 0 },
    { diffBytes: 32769 },
    { diffSha256: 'wrong' },
    { fixture: 'true' },
    { fixture: true, fixtureSha256: hash(diff) },
    { fixtureSha256: hash(diff) },
  ])
    assert.throws(() => renderReview(review(), provenance(changes)));
  assert.throws(() =>
    renderReview(
      review(),
      provenance({
        fixture: true,
        pr: undefined,
        base: undefined,
        head: undefined,
        fixtureSha256: 'd'.repeat(64),
      }),
    ),
  );
  assert.throws(() => renderReview(review({ verdict: 'OK' }), provenance()));
});
