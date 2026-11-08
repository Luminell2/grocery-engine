// Language-agnostic text normalization used for matching and dataset search.

export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (é->e, ü->u, й->и on both sides consistently)
    .replace(/ß/g, 'ss')
    .replace(/ł/g, 'l')
    .replace(/[’'`´]/g, '');
}

export function tokenize(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 || /\d/.test(t));
}

function commonPrefix(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// Endings that are just inflection (plural / case), not a new compound word.
const INFLECTION = new Set(['', 's', 'e', 'n', 'en', 'er', 'es', 'ne', 'a', 'i', 'y', 'ы', 'и', 'а', 'я', 'ов', 'ей', 'ів', 'ек', 'ok', 'ki', 'ow', 'jes', 'tjes']);

export type TokenMatch = 'head' | 'modifier' | 'none';

/**
 * How does a product-name token relate to an ingredient term token?
 *  head     – same word, inflection, or compound ending in the term ("Kirsch|tomaten")
 *  modifier – compound that STARTS with the term but is something else ("Zitronen|radler",
 *             "citroen|sap", "Eier|muschelsuppe") – the ingredient is only a flavour/attribute
 */
export function tokenMatch(token: string, term: string): TokenMatch {
  if (token === term) return 'head';
  if (token.startsWith(term)) {
    const rest = token.slice(term.length);
    return INFLECTION.has(rest) ? 'head' : rest.length <= 2 ? 'head' : 'modifier';
  }
  if (term.length >= 4 && token.endsWith(term)) return 'head';
  // inflection on either side: pomidor/pomidory, rot/rote, яйцо/яйца, tomate/tomato
  // Both leftovers must be inflections ("olivenöl" vs "oliven" leaves "ol" -> different product).
  const cp = commonPrefix(token, term);
  const isInfl = (r: string) => r.length <= 1 || INFLECTION.has(r);
  if (cp >= 3 && cp >= 0.75 * Math.min(token.length, term.length) && isInfl(token.slice(cp)) && isInfl(term.slice(cp))) return 'head';
  // compound ending in an inflected term: "Rinder|hackfleisch" vs "hackfleisch" handled above;
  // "Kirsch|tomate" vs "tomaten":
  if (term.length >= 5 && token.length > term.length) {
    const stem = term.slice(0, -1);
    if (token.endsWith(stem)) return 'head';
  }
  return 'none';
}

export function hasToken(nameTokens: string[], term: string): boolean {
  return nameTokens.some((t) => tokenMatch(t, term) !== 'none');
}

/** Prepositions / connectors: an ingredient appearing after one is usually not the product itself. */
export const PREPOSITIONS = new Set([
  'de', 'del', 'della', 'di', 'en', 'con', 'al', 'alla', 'sabor', 'mit', 'in', 'im', 'auf', 'nach', 'met', 'van', 'op', 'w', 'z', 'ze', 'na', 'o',
  'з', 'із', 'с', 'со', 'в', 'во', 'на', 'зі', 'au', 'aux', 'a', 'avec', 'with', 'of', 'in', 'and', 'und', 'en', 'y', 'i', 'и', 'та', 'vs', 'ja',
]);
