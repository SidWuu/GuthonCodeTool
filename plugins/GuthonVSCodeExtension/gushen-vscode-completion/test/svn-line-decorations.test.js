const assert = require('node:assert/strict');
const test = require('node:test');
const { decorationOptions } = require('../src/svn/line-decorations');

test('maps SVN line changes to editor ranges and deletion markers', () => {
  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
    }
  }
  const document = {
    lineCount: 4,
    lineAt: (line) => ({ text: ['one', 'two', 'three', 'four'][line] }),
  };
  const result = decorationOptions({ Range }, document, [
    { type: 'added', startLine: 1, endLine: 2 },
    { type: 'modified', startLine: 3, endLine: 3 },
    { type: 'deleted', startLine: 9, endLine: 9, deletedLines: 2 },
  ]);

  assert.deepEqual(result.added[0].range, new Range(1, 0, 2, 5));
  assert.deepEqual(result.modified[0].range, new Range(3, 0, 3, 4));
  assert.deepEqual(result.deleted[0].range, new Range(3, 0, 3, 4));
  assert.match(result.deleted[0].hoverMessage, /2 行/);
});
