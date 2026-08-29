import { AITask } from './AIProvider';

const TASK_FOCUS: Record<AITask, string> = {
    general: 'Answer only the requested Karate test-management task.',
    'generate-openapi': 'Generate tests only from documented OpenAPI operations, schemas, constraints, and response codes.',
    'generate-postman': 'Preserve Postman requests, variables, authentication, scripts, assertions, and execution order while converting them to native Karate DSL.',
    'generate-har': 'Preserve the captured HTTP flow and convert only evidenced requests, headers, parameters, and bodies.',
    'generate-requirements': 'Translate only supplied requirements into traceable, focused Karate scenarios.',
    'enhance-feature': 'Improve the supplied feature without changing its intended behavior or inventing API contracts.',
    'repair-scenario': 'Repair only the exact failing scenario and preserve unrelated feature content.',
    'analyze-coverage': 'Compare only the supplied specification and explicit Karate feature scope. Report evidence and gaps without inventing coverage.',
    'generate-missing-test': 'Generate a focused test for the identified coverage gap using only supplied contract evidence.',
    'analyze-flakiness': 'Focus on deterministic setup, asynchronous behavior, shared state, isolation, retries, and parallel safety.',
    'suggest-reusability': 'Focus on shallow, useful reuse with Background, call, callonce, callSingle, explicit helper inputs, and @ignore helpers.'
};

export class KaratePromptComposer {
    static compose(prompt: string, task: AITask = 'general', systemPrompt?: string): { prompt: string; systemPrompt: string } {
        const core = [
            'You are a professional Karate DSL test engineer.',
            TASK_FOCUS[task],
            'Follow the existing project structure, tags, configuration, runner, and naming conventions.',
            'Use only endpoints, fields, schemas, requirements, and failure evidence present in the supplied context.',
            'Prefer native Karate DSL over custom JavaScript; keep scenarios readable, independent, deterministic, and parallel-safe.',
            'Never emit credentials, hard-coded environment URLs, invented contracts, markdown fences, or explanations unless explicitly requested.'
        ].join('\n');

        return {
            systemPrompt: systemPrompt ? `${core}\n${systemPrompt}` : core,
            prompt
        };
    }
}
