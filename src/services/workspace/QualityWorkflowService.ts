import { WorkspaceEntity, WorkspaceEntityStore } from './WorkspaceEntityStore';

export type QualityState = 'New' | 'Investigating' | 'Fixed' | 'Verified';

export interface QualityFinding extends WorkspaceEntity {
    title: string;
    severity: 'low' | 'normal' | 'high' | 'critical';
    state: QualityState;
    source: 'coverage' | 'health' | 'flakiness' | 'spec-diff' | 'ci' | 'bug-hunter';
    description?: string;
    sourceRef?: string;
}

const TRANSITIONS: Record<QualityState, QualityState[]> = {
    New: ['Investigating'],
    Investigating: ['Fixed'],
    Fixed: ['Verified', 'Investigating'],
    Verified: []
};

/** Enforces the Quality queue lifecycle instead of letting UI code mutate arbitrary strings. */
export class QualityWorkflowService {
    constructor(private readonly store: WorkspaceEntityStore) { }

    create(input: Omit<QualityFinding, 'id' | 'createdAt' | 'updatedAt' | 'state'> & { state?: QualityState }): QualityFinding {
        return this.store.save('findings', { ...input, state: input.state || 'New' }) as QualityFinding;
    }

    advance(id: string, next: QualityState): QualityFinding {
        const finding = this.store.get<QualityFinding>('findings', id);
        if (!finding) throw new Error('Quality finding no longer exists.');
        if (!TRANSITIONS[finding.state].includes(next)) {
            throw new Error(`Cannot move a ${finding.state} finding to ${next}.`);
        }
        return this.store.save('findings', { ...finding, state: next }, id) as QualityFinding;
    }

    nextState(state: QualityState): QualityState | undefined {
        return TRANSITIONS[state][0];
    }

    /** Keeps recurring coverage scans actionable without creating duplicate open work. */
    recordCoverageGap(input: Pick<QualityFinding, 'title' | 'severity' | 'description' | 'sourceRef'>): QualityFinding {
        return this.upsertOpen({ ...input, source: 'coverage' });
    }

    /** Updates an open finding with the same external source identity. */
    upsertOpen(input: Omit<QualityFinding, 'id' | 'createdAt' | 'updatedAt' | 'state'> & { state?: QualityState }): QualityFinding {
        const existing = this.store.list<QualityFinding>('findings').find(finding =>
            finding.source === input.source && finding.sourceRef === input.sourceRef && finding.state !== 'Verified'
        );
        if (existing) {
            return this.store.save('findings', { ...existing, ...input }, existing.id) as QualityFinding;
        }
        return this.create(input);
    }
}
