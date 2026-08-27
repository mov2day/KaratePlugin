/** Normalizes persisted-run retention independently of the VS Code host. */
export function normalizeHistoryLimit(value: number | undefined): number {
    return Math.max(1, Number.isFinite(value) ? Math.floor(value as number) : 50);
}
