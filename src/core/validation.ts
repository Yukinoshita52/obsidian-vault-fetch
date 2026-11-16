export function hasControlCharacters(value: string, includeSpace = false): boolean {
  const maximum = includeSpace ? 32 : 31;
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= maximum || code === 127;
  });
}
