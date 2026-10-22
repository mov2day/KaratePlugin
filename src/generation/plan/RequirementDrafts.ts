/** Interim mapping of Confluence test cases to all-draft scenarios (real requirement mapping arrives in Task 14). Pure. */
import type { PlannedFeature } from './OpenApiPlanner';

export const REQUIREMENT_DRAFT_REASON = 'No API contract linked for this requirement; refine with AI or map to an operation';

export interface RequirementCase {
    name?: string;
    description?: string;
    steps?: string[];
    expectedResult?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function requirementsFeature(specName: string, pageTitle: string, cases: RequirementCase[]): PlannedFeature | undefined {
    if (cases.length === 0) {return undefined;}
    return {
        relativePath: `${specName}-requirements.feature`,
        feature: {
            name: `${specName} - ${oneLine(pageTitle) || 'requirements'} (requirements)`,
            description: `Draft scenarios from Confluence page "${oneLine(pageTitle)}"`,
            background: { steps: [{ keyword: '*', text: 'url baseUrl' }] },
            scenarios: cases.map((c, i) => ({
                name: oneLine(c.name ?? '') || `Requirement ${i + 1}`,
                description: c.description ? oneLine(c.description) : undefined,
                tags: ['positive'],
                comments: [
                    ...(c.steps ?? []).map((s, n) => `${n + 1}. ${oneLine(s)}`),
                    ...(c.expectedResult ? [`Expected: ${oneLine(c.expectedResult)}`] : [])
                ],
                steps: [{ keyword: '*', text: "karate.log('TODO: map this requirement to an API operation')" }],
                draftReason: REQUIREMENT_DRAFT_REASON
            }))
        }
    };
}
