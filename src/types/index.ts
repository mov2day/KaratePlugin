export interface KarateFeature {
    name: string;
    description?: string;
    background?: KarateBackground;
    scenarios: KarateScenario[];
}

export interface KarateBackground {
    steps: KarateStep[];
}

export interface KarateScenario {
    name: string;
    description?: string;
    steps: KarateStep[];
    tags?: string[];
}

export interface KarateStep {
    keyword: 'Given' | 'When' | 'Then' | 'And' | 'But' | '*';
    text: string;
    docString?: string;
    table?: string[][];
}

export interface OpenAPIEndpoint {
    path: string;
    method: string;
    operationId?: string;
    summary?: string;
    description?: string;
    parameters?: OpenAPIParameter[];
    requestBody?: OpenAPIRequestBody;
    responses?: Record<string, OpenAPIResponse>;
    tags?: string[];
}

export interface OpenAPIParameter {
    name: string;
    in: 'query' | 'header' | 'path' | 'cookie';
    required?: boolean;
    schema?: any;
    description?: string;
}

export interface OpenAPIRequestBody {
    required?: boolean;
    content?: Record<string, { schema?: any }>;
}

export interface OpenAPIResponse {
    description?: string;
    content?: Record<string, { schema?: any }>;
}

export interface ConfluenceTestData {
    requirements: string[];
    testCases: ConfluenceTestCase[];
    flowSteps: string[];
}

export interface ConfluenceTestCase {
    name: string;
    description?: string;
    steps: string[];
    expectedResult?: string;
}
