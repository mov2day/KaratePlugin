/** The one slug function shared by the planner and batch namespacing, so prefixes stay unique after slugging. */
export function slug(s: string): string {
    return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
