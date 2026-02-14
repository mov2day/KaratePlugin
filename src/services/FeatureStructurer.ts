import * as path from 'path';
import { KarateFeature, KarateScenario, KarateStep, OpenAPIEndpoint } from '../types';
import { logger } from '../utils/logger';

export interface StructuringOptions {
    strategy: 'domain' | 'flat' | 'method';
    autoTag: boolean;
    outputRoot: string;
}

export interface StructuredFile {
    relativePath: string;
    featureName: string;
    content: string;
}

export interface StructuredOutput {
    files: StructuredFile[];
    commonFiles: string[];
}

/**
 * Organizes generated scenarios into domain-grouped, tag-annotated feature files.
 * Domain detection uses OpenAPI tags[] first, falling back to path prefix.
 */
export class FeatureStructurer {
    private static readonly CATEGORY_TAGS: Record<string, string> = {
        positive: '@positive',
        negative: '@negative',
        edge: '@edge',
        boundary: '@boundary',
        security: '@security'
    };

    /**
     * Detect the domain for an endpoint using tags[] or path prefix fallback
     */
    static detectDomain(endpoint: OpenAPIEndpoint): string {
        // Use first OpenAPI tag if available
        if (endpoint.tags && endpoint.tags.length > 0) {
            return endpoint.tags[0].toLowerCase().replace(/\s+/g, '-');
        }

        // Fallback: extract from path prefix (/orders/123 → orders)
        const pathSegments = endpoint.path.split('/').filter(s => s && !s.startsWith('{'));
        if (pathSegments.length > 0) {
            return pathSegments[0].toLowerCase();
        }

        return 'general';
    }

    /**
     * Classify a scenario as positive/negative/edge based on its content
     */
    static classifyScenario(scenario: KarateScenario): 'positive' | 'negative' | 'edge' | 'boundary' | 'security' {
        // Already classified
        if (scenario.category) {
            return scenario.category;
        }

        const name = scenario.name.toLowerCase();
        const stepsText = scenario.steps.map(s => s.text.toLowerCase()).join(' ');

        // Check for negative indicators
        if (name.includes('invalid') || name.includes('error') || name.includes('fail') ||
            name.includes('missing') || name.includes('unauthorized') || name.includes('forbidden') ||
            stepsText.includes('status 400') || stepsText.includes('status 401') ||
            stepsText.includes('status 403') || stepsText.includes('status 404') ||
            stepsText.includes('status 500') || stepsText.includes('status 422')) {
            return 'negative';
        }

        // Check for boundary indicators
        if (name.includes('boundary') || name.includes('min') || name.includes('max') ||
            name.includes('limit') || name.includes('overflow')) {
            return 'boundary';
        }

        // Check for edge case indicators
        if (name.includes('edge') || name.includes('empty') || name.includes('null') ||
            name.includes('special character') || name.includes('unicode') ||
            name.includes('zero') || name.includes('duplicate')) {
            return 'edge';
        }

        // Check for security indicators
        if (name.includes('auth') || name.includes('token') || name.includes('permission') ||
            name.includes('security') || name.includes('role')) {
            return 'security';
        }

        return 'positive';
    }

    /**
     * Inject classification tags into scenario tags array
     */
    static injectTags(scenario: KarateScenario, domain: string): KarateScenario {
        const category = this.classifyScenario(scenario);
        const tags = [...(scenario.tags || [])];

        // Add category tag if not already present
        const categoryTag = category;
        if (!tags.includes(categoryTag)) {
            tags.push(categoryTag);
        }

        // Add domain tag if not already present
        if (!tags.includes(domain)) {
            tags.push(domain);
        }

        return {
            ...scenario,
            tags,
            category,
            domain
        };
    }

    /**
     * Group scenarios by domain and produce structured output
     */
    static structure(
        scenarios: KarateScenario[],
        endpoints: OpenAPIEndpoint[],
        options: StructuringOptions
    ): StructuredOutput {
        const files: StructuredFile[] = [];

        if (options.strategy === 'flat') {
            // Flat: single file with all scenarios
            const flatFeature = this.buildFeatureContent('API Tests', scenarios, options);
            files.push({
                relativePath: 'api-tests.feature',
                featureName: 'API Tests',
                content: flatFeature
            });
            return { files, commonFiles: [] };
        }

        if (options.strategy === 'method') {
            // Group by HTTP method
            const byMethod = new Map<string, KarateScenario[]>();
            for (let i = 0; i < scenarios.length; i++) {
                const method = endpoints[i]?.method?.toLowerCase() || 'get';
                if (!byMethod.has(method)) {
                    byMethod.set(method, []);
                }
                byMethod.get(method)!.push(scenarios[i]);
            }

            for (const [method, methodScenarios] of byMethod) {
                const featureName = `${method.toUpperCase()} API Tests`;
                const content = this.buildFeatureContent(featureName, methodScenarios, options);
                files.push({
                    relativePath: `${method}.feature`,
                    featureName,
                    content
                });
            }
            return { files, commonFiles: [] };
        }

        // Domain strategy (default): group by domain, one file per domain
        const domainMap = new Map<string, KarateScenario[]>();

        for (let i = 0; i < scenarios.length; i++) {
            const endpoint = endpoints[i];
            const domain = endpoint ? this.detectDomain(endpoint) : (scenarios[i].domain || 'general');

            // Classify and tag the scenario
            const taggedScenario = options.autoTag
                ? this.injectTags(scenarios[i], domain)
                : { ...scenarios[i], domain };

            if (!domainMap.has(domain)) {
                domainMap.set(domain, []);
            }
            domainMap.get(domain)!.push(taggedScenario);
        }

        for (const [domain, domainScenarios] of domainMap) {
            const featureName = `${this.capitalize(domain)} API`;
            const content = this.buildFeatureContent(featureName, domainScenarios, options);
            files.push({
                relativePath: `${domain}.feature`,
                featureName,
                content
            });
        }

        logger.info(`FeatureStructurer: produced ${files.length} domain files from ${scenarios.length} scenarios`);
        return { files, commonFiles: [] };
    }

    /**
     * Structure for combined (OpenAPI + Confluence) flows with meaningful names
     */
    static structureCombined(
        scenarios: KarateScenario[],
        endpoints: OpenAPIEndpoint[],
        confluenceContext: string,
        options: StructuringOptions
    ): StructuredOutput {
        // Derive a short context label from Confluence page title/content
        const contextLabel = this.deriveContextLabel(confluenceContext);

        if (options.strategy === 'flat') {
            const featureName = `API Tests with ${contextLabel}`;
            const content = this.buildFeatureContent(featureName, scenarios, options);
            return {
                files: [{
                    relativePath: `api_with_${this.slugify(contextLabel)}.feature`,
                    featureName,
                    content
                }],
                commonFiles: []
            };
        }

        // Domain strategy with meaningful combined names
        const domainMap = new Map<string, KarateScenario[]>();

        for (let i = 0; i < scenarios.length; i++) {
            const endpoint = endpoints[i];
            const domain = endpoint ? this.detectDomain(endpoint) : (scenarios[i].domain || 'general');
            const taggedScenario = options.autoTag
                ? this.injectTags(scenarios[i], domain)
                : { ...scenarios[i], domain };

            if (!domainMap.has(domain)) {
                domainMap.set(domain, []);
            }
            domainMap.get(domain)!.push(taggedScenario);
        }

        const files: StructuredFile[] = [];
        for (const [domain, domainScenarios] of domainMap) {
            const featureName = `${this.capitalize(domain)} API with ${contextLabel}`;
            const content = this.buildFeatureContent(featureName, domainScenarios, options);
            files.push({
                relativePath: `${domain}_api_with_${this.slugify(contextLabel)}.feature`,
                featureName,
                content
            });
        }

        logger.info(`FeatureStructurer: produced ${files.length} combined domain files`);
        return { files, commonFiles: [] };
    }

    /**
     * Build a Karate feature file string from scenarios
     */
    private static buildFeatureContent(
        featureName: string,
        scenarios: KarateScenario[],
        options: StructuringOptions
    ): string {
        const lines: string[] = [];

        lines.push(`Feature: ${featureName}`);
        lines.push('');
        lines.push('  Background:');
        lines.push('    * url baseUrl');
        lines.push('');

        for (const scenario of scenarios) {
            // Tags
            if (scenario.tags && scenario.tags.length > 0) {
                lines.push(`  @${scenario.tags.join(' @')}`);
            }

            lines.push(`  Scenario: ${scenario.name}`);
            if (scenario.description) {
                lines.push(`    # ${scenario.description}`);
            }

            for (const step of scenario.steps) {
                lines.push(this.stepToString(step));
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Convert a step to feature file string
     */
    private static stepToString(step: KarateStep): string {
        let line = `    ${step.keyword} ${step.text}`;

        if (step.docString) {
            return `${line}\n    """\n${step.docString}\n    """`;
        }

        if (step.table) {
            const tableLines = step.table.map(row =>
                `      | ${row.join(' | ')} |`
            ).join('\n');
            return `${line}\n${tableLines}`;
        }

        return line;
    }

    /**
     * Derive a short context label from Confluence content
     */
    private static deriveContextLabel(confluenceContent: string): string {
        // Try to extract a title from HTML
        const titleMatch = confluenceContent.match(/<title[^>]*>([^<]+)<\/title>/i) ||
            confluenceContent.match(/<h1[^>]*>([^<]+)<\/h1>/i);

        if (titleMatch) {
            return titleMatch[1].trim().substring(0, 40);
        }

        // Fallback: use first meaningful words
        const plainText = confluenceContent.replace(/<[^>]+>/g, ' ').trim();
        const words = plainText.split(/\s+/).filter(w => w.length > 2).slice(0, 4);
        return words.length > 0 ? words.join(' ') : 'Business Rules';
    }

    /**
     * Convert a string to a URL/filename-safe slug
     */
    private static slugify(text: string): string {
        return text.toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .substring(0, 30);
    }

    /**
     * Capitalize first letter
     */
    private static capitalize(text: string): string {
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
}
