import { AIModelMode, AITask } from './AIProvider';

export type ModelCapabilityTier = 'fast' | 'balanced' | 'deep';
export type ModelCostTier = 'low' | 'medium' | 'high';

export interface ModelCandidate {
    id: string;
    name?: string;
    family?: string;
    vendor?: string;
    maxInputTokens: number;
}

export interface ModelProfile {
    capability: ModelCapabilityTier;
    cost: ModelCostTier;
    family: string;
}

const FAST_TASKS = new Set<AITask>([
    'analyze-coverage',
    'suggest-reusability'
]);

/**
 * Classify stable family names rather than complete versioned model IDs. The
 * VS Code API does not expose price or reasoning-quality metadata, so unknown
 * families stay out of automatic routing and remain available for exact user
 * selection.
 */
export function classifyModel(candidate: ModelCandidate): ModelProfile | undefined {
    const identity = [candidate.vendor, candidate.family, candidate.name, candidate.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    if (/\bhaiku\b/.test(identity)) return { capability: 'fast', cost: 'low', family: 'Haiku' };
    if (/\bsonnet\b/.test(identity)) return { capability: 'balanced', cost: 'medium', family: 'Sonnet' };
    if (/\bopus\b/.test(identity)) return { capability: 'deep', cost: 'high', family: 'Opus' };
    if (/\bfable\b/.test(identity)) return { capability: 'deep', cost: 'high', family: 'Fable' };

    if (/\bluna\b/.test(identity)) return { capability: 'fast', cost: 'low', family: 'Luna' };
    if (/\bterra\b/.test(identity)) return { capability: 'balanced', cost: 'medium', family: 'Terra' };
    if (/\bsol\b/.test(identity)) return { capability: 'deep', cost: 'high', family: 'Sol' };

    // More specific families precede broad markers such as mini and flash.
    if (/\bmai[- ]code\b/.test(identity)) return { capability: 'balanced', cost: 'medium', family: 'MAI Code' };
    if (/\braptor\b/.test(identity)) return { capability: 'fast', cost: 'low', family: 'Raptor' };
    if (/\bkimi\s*k?3\b|\bkimi[- ]k?3\b/.test(identity)) return { capability: 'deep', cost: 'high', family: 'Kimi K3' };
    if (/\bkimi\b|\bk2\.7\b/.test(identity)) return { capability: 'balanced', cost: 'medium', family: 'Kimi Code' };
    if (/\bgrok\b/.test(identity)) return { capability: 'balanced', cost: 'high', family: 'Grok' };

    if (/\bgemini\b.*\bflash\b/.test(identity)) return { capability: 'fast', cost: 'low', family: 'Gemini Flash' };
    if (/\bgemini\b.*\bpro\b/.test(identity)) return { capability: 'deep', cost: 'high', family: 'Gemini Pro' };

    if (/\bgpt\b.*\b(?:nano|mini)\b|\bgpt[-_.]?\d[^ ]*[-_.](?:nano|mini)\b/.test(identity)) {
        return { capability: 'fast', cost: 'low', family: 'GPT lightweight' };
    }
    if (/\bcodex\b/.test(identity)) return { capability: 'balanced', cost: 'high', family: 'Codex' };
    if (/\bgpt[-_. ]?5\.(?:4|5)\b/.test(identity)) return { capability: 'deep', cost: 'high', family: 'GPT reasoning' };

    return undefined;
}

export function requiredCapability(task: AITask = 'general', mode: AIModelMode): ModelCapabilityTier {
    if (mode === 'highest-quality') return 'deep';
    if (mode === 'balanced') return 'balanced';
    return FAST_TASKS.has(task) ? 'fast' : 'balanced';
}

/**
 * Orders live models by task capability and a strict cost ceiling. Efficient
 * mode uses fast/low-cost models for lightweight analysis and balanced/medium
 * models for production generation. Deep/high-cost models are considered only
 * after an explicit highest-quality selection or exact model choice.
 */
export function orderModelCandidates<T extends ModelCandidate>(
    candidates: T[],
    inputTokens: ReadonlyMap<string, number>,
    mode: AIModelMode,
    exactModelId?: string,
    task: AITask = 'general'
): T[] {
    const eligible = candidates.filter(candidate => {
        const tokens = inputTokens.get(candidate.id);
        return tokens !== undefined && tokens <= Math.floor(candidate.maxInputTokens * 0.85);
    });

    if (exactModelId) {
        const exact = eligible.find(candidate => candidate.id === exactModelId);
        return exact ? [exact] : [];
    }

    const profiled = eligible
        .map(candidate => ({ candidate, profile: classifyModel(candidate) }))
        .filter((item): item is { candidate: T; profile: ModelProfile } => Boolean(item.profile));

    if (mode === 'highest-quality') {
        return profiled.sort((left, right) =>
            capabilityRank(right.profile.capability) - capabilityRank(left.profile.capability)
            || costRank(right.profile.cost) - costRank(left.profile.cost)
            || right.candidate.maxInputTokens - left.candidate.maxInputTokens
            || left.candidate.id.localeCompare(right.candidate.id)
        ).map(item => item.candidate);
    }

    const target = requiredCapability(task, mode);
    const costCeiling = target === 'fast' ? costRank('low') : costRank('medium');
    const withinBudget = profiled.filter(item => costRank(item.profile.cost) <= costCeiling);
    const preferred = withinBudget.filter(item => item.profile.capability === target);
    const fallback = withinBudget.filter(item => item.profile.capability !== target);

    const rank = (left: { candidate: T; profile: ModelProfile }, right: { candidate: T; profile: ModelProfile }) =>
        Math.abs(capabilityRank(left.profile.capability) - capabilityRank(target))
        - Math.abs(capabilityRank(right.profile.capability) - capabilityRank(target))
        || costRank(left.profile.cost) - costRank(right.profile.cost)
        || right.candidate.maxInputTokens - left.candidate.maxInputTokens
        || left.candidate.id.localeCompare(right.candidate.id);

    return [...preferred.sort(rank), ...fallback.sort(rank)].map(item => item.candidate);
}

function capabilityRank(value: ModelCapabilityTier): number {
    return value === 'fast' ? 0 : value === 'balanced' ? 1 : 2;
}

function costRank(value: ModelCostTier): number {
    return value === 'low' ? 0 : value === 'medium' ? 1 : 2;
}
