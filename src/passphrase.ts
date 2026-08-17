import { randomBytes } from "node:crypto";

const CONSONANTS = "bcdfghjkmnprstvw";
const VOWELS = "aeio";
const WORD_COUNT = 6;
const SYLLABLES_PER_WORD = 3;

export function generatePassphrase(): string {
  const bytes = randomBytes(WORD_COUNT * SYLLABLES_PER_WORD);
  const words: string[] = [];

  for (let wordIndex = 0; wordIndex < WORD_COUNT; wordIndex += 1) {
    let word = "";
    for (let syllable = 0; syllable < SYLLABLES_PER_WORD; syllable += 1) {
      const value = bytes[wordIndex * SYLLABLES_PER_WORD + syllable];
      word += CONSONANTS[value >> 4];
      word += VOWELS[(value >> 2) & 3];
    }
    words.push(word);
  }

  return words.join("-");
}
