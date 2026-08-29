import { AIModelMode } from './AIProvider';

export interface ModelCandidate {
    id: string;
    maxInputTokens: number;
}

/**
 * Selects without relying on provider-specific model names or stale price tables.
 * Efficient uses the smallest context window that safely fits the request;
 * balanced uses the median eligible model; highest-quality is an explicit opt-in
 * and uses the largest eligible context window.
 */
export function orderModelCandidates<T extends ModelCandidate>(
    candidates: T[],
    inputTokens: ReadonlyMap<string, number>,
    mode: AIModelMode,
    exactModelId?: string
): T[] {
    const eligible = candidates.filter(candidate => {
        const tokens = inputTokens.get(candidate.id);
        return tokens !== undefined && tokens <= Math.floor(candidate.maxInputTokens * 0.85);
    });

    if (exactModelId) {
        const exact = eligible.find(candidate => candidate.id === exactModelId);
        return exact ? [exact] : [];
    }

    const ascending = [...eligible].sort((left, right) =>
        left.maxInputTokens - right.maxInputTokens || left.id.localeCompare(right.id)
    );

    if (mode === 'highest-quality') {
        return ascending.reverse();
    }

    if (mode === 'balanced' && ascending.length > 2) {
        const middle = Math.floor((ascending.length - 1) / 2);
        return [
            ...ascending.slice(middle),
            ...ascending.slice(0, middle).reverse()
        ];
    }

    return ascending;
}
