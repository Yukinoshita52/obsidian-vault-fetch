import { expect, it } from 'vitest';
import { hasControlCharacters } from '../../src/core/validation';
import { normalizeRepository } from '../../src/core/github';

it('rejects every ASCII control character while keeping spaces optional', () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const value = `before${String.fromCharCode(code)}after`;
    expect(hasControlCharacters(value)).toBe(true);
    expect(hasControlCharacters(value, true)).toBe(true);
  }
  expect(hasControlCharacters('a b')).toBe(false);
  expect(hasControlCharacters('a b', true)).toBe(true);
  expect(hasControlCharacters('example/插件')).toBe(false);
});

it('continues rejecting control characters in repository URLs before parsing normalizes them', () => {
  for (const code of [...Array.from({ length: 33 }, (_, index) => index), 127]) {
    expect(() => normalizeRepository(`https://github.com/example/sam${String.fromCharCode(code)}ple`)).toThrow();
  }
});
