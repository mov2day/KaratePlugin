/** Render only the scenarios for selected operations (no Feature/Background header). Pure. */
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { GenerationModel } from '../model/TestModel';
import { renderScenario } from '../render/FeatureRenderer';
import { planOpenApi } from './OpenApiPlanner';

/** Source reference used by the OpenAPI adapter for an operation, e.g. `GET /pets/{id}`. */
export const operationSourceRef = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

/**
 * Scenarios for the operations whose `sourceRef` is in `sourceRefs`, rendered and joined by a blank line.
 * Returns '' when no operation matches or nothing could be planned, so callers can fall back.
 */
export function renderScenariosForOperations(model: GenerationModel, sourceRefs: string[], config: GeneratorConfig): string {
    const wanted = new Set(sourceRefs);
    const operations = model.operations.filter(o => wanted.has(o.sourceRef));
    if (operations.length === 0) {return '';}
    // Snippets merge into existing files, so they must not reference data/schema files that may not exist: inline both.
    const snippetConfig: GeneratorConfig = { ...config, scenarios: { ...config.scenarios, crud: false }, data: { ...config.data, externalize: false } };
    const plan = planOpenApi({ ...model, operations }, snippetConfig, { inlineSchemas: true });
    const scenarios = plan.features.flatMap(f => f.feature.scenarios);
    return scenarios.map(s => renderScenario(s, config.style)).join('\n\n');
}
