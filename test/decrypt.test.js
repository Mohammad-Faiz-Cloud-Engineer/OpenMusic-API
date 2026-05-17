const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decryptMediaUrl } = require('../Jio Saavn/decrypt');

describe('decryptMediaUrl', () => {
  it('rejects empty or non-string input', () => {
    assert.throws(() => decryptMediaUrl(''), /Invalid encrypted URL/);
    assert.throws(() => decryptMediaUrl(null), /Invalid encrypted URL/);
  });

  it('rejects invalid base64 ciphertext', () => {
    assert.throws(() => decryptMediaUrl('not-valid-base64!!!'), /empty result|Invalid/);
  });
});
