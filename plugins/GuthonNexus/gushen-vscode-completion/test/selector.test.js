const test = require('node:test');
const assert = require('node:assert/strict');

const { createDocumentSelector } = require('../src/selector');

test('registers completion for saved and untitled documents', () => {
  assert.deepEqual(createDocumentSelector(['java'], ['file', 'untitled']), [
    { language: 'java', scheme: 'file' },
    { language: 'java', scheme: 'untitled' },
  ]);
});

test('registers all supported languages for both schemes', () => {
  const selector = createDocumentSelector(
    ['java', 'javascript', 'sql'],
    ['file', 'untitled']
  );

  assert.equal(selector.length, 6);
  assert(selector.some((item) => item.language === 'java' && item.scheme === 'untitled'));
  assert(selector.some((item) => item.language === 'javascript' && item.scheme === 'untitled'));
  assert(selector.some((item) => item.language === 'sql' && item.scheme === 'untitled'));
});
