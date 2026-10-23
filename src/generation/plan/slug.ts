import { createHash } from 'crypto';

/**
 * The one slug function shared by the planner and batch namespacing, so prefixes stay unique after slugging.
 * Accents are transliterated (`Édge` -> `edge`). Input made of letters or digits that have no Latin form
 * (for example `日本`) gets a stable short hash name instead of an empty or colliding slug; input with no
 * letters or digits at all still slugs to ''.
 */
export function slug(s: string): string {
    const base = s.normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (base !== '' || !/[\p{L}\p{N}]/u.test(s)) {return base;}
    return `folder-${createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 6)}`;
}
