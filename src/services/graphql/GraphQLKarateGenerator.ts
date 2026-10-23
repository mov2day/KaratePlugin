import { DEFAULT_GENERATOR_CONFIG } from '../../generation/config/GeneratorConfig';
import { buildGraphQLPlan } from '../../generation/adapters/graphql';
import { renderFeature } from '../../generation/render/FeatureRenderer';
import type { KarateStep } from '../../types';
import type { GraphQLSchema } from './GraphQLParser';

/**
 * GraphQLKarateGenerator: thin wrapper over the GraphQL generation adapter that renders one feature file.
 * The extension command runs the adapter through the shared generation pipeline instead.
 */
export class GraphQLKarateGenerator {
    /**
     * Render all planned scenarios of a GraphQL schema as a single Karate feature (default generator config).
     * The URL comes from the `baseUrl` variable, never from this call.
     */
    generate(schema: GraphQLSchema, _endpointUrl?: string): string {
        const config = DEFAULT_GENERATOR_CONFIG;
        const plan = buildGraphQLPlan(schema, { config, name: schema.name });
        if (plan.features.length === 0) {
            return `Feature: ${schema.name}\n`;
        }
        const background: KarateStep[] = [];
        for (const step of plan.features.flatMap(f => f.feature.background?.steps ?? [])) {
            if (!background.some(b => b.text === step.text)) {background.push(step);}
        }
        return renderFeature({
            name: schema.name,
            description: plan.features[0].feature.description,
            background: { steps: background },
            scenarios: plan.features.flatMap(f => f.feature.scenarios)
        }, { style: config.style });
    }
}
