export interface SearchScenario {
    name: string;
    tags: string[];
    owner?: string;
    status?: string;
    zephyrKey?: string;
}

export interface SearchFeature {
    path: string;
    scenarios: SearchScenario[];
}

export interface SearchRun {
    id: string;
    timestamp: number;
    status: string;
    options?: { environment?: string; target?: string | string[] };
}

export interface SearchFinding {
    title?: string;
    source?: string;
    state?: string;
    severity?: string;
}

export interface ManagementSearchSource {
    features?: SearchFeature[];
    runs?: SearchRun[];
    findings?: SearchFinding[];
}

export interface ManagementSearchResults {
    scenarios: Array<{ feature: SearchFeature; scenario: SearchScenario }>;
    runs: SearchRun[];
    findings: SearchFinding[];
    total: number;
}

/** Search only the already-indexed management snapshot; never read the workspace here. */
export function searchManagement(source: ManagementSearchSource, query: string): ManagementSearchResults {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return { scenarios: [], runs: [], findings: [], total: 0 };
    }

    let total = 0;
    const scenarios: ManagementSearchResults['scenarios'] = [];
    for (const feature of source.features || []) {
        for (const scenario of feature.scenarios) {
            const searchable = `${feature.path} ${scenario.name} ${scenario.tags.join(' ')} ${scenario.owner || ''} ${scenario.status || ''} ${scenario.zephyrKey || ''}`.toLowerCase();
            if (!searchable.includes(normalized)) {
                continue;
            }
            total++;
            if (scenarios.length < 5) {
                scenarios.push({ feature, scenario });
            }
        }
    }

    const runs: SearchRun[] = [];
    for (const run of source.runs || []) {
        const target = Array.isArray(run.options?.target) ? run.options?.target.join(' ') : run.options?.target || '';
        if (!`${run.id} ${run.status} ${run.options?.environment || ''} ${target}`.toLowerCase().includes(normalized)) {
            continue;
        }
        total++;
        if (runs.length < 4) {
            runs.push(run);
        }
    }

    const findings: SearchFinding[] = [];
    for (const finding of source.findings || []) {
        if (!`${finding.title || ''} ${finding.source || ''} ${finding.state || ''} ${finding.severity || ''}`.toLowerCase().includes(normalized)) {
            continue;
        }
        total++;
        if (findings.length < 4) {
            findings.push(finding);
        }
    }
    return { scenarios, runs, findings, total };
}
