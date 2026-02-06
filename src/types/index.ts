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

// Test Execution Types
export interface TestExecutionOptions {
    type: 'feature' | 'features' | 'folder' | 'tags' | 'scenario';
    target: string | string[]; // file path(s), folder path, or scenario identifier
    tags?: string[]; // for tag-based execution
    environment?: string; // e.g., 'dev', 'staging', 'prod'
    buildTool?: 'maven' | 'gradle' | 'cli'; // execution method
    parallel?: number; // parallel thread count
    workingDirectory?: string; // project root for build tools
}

export interface TestExecutionResult {
    id: string; // unique execution ID
    timestamp: number;
    options: TestExecutionOptions;
    summary: TestSummary;
    features: FeatureResult[];
    duration: number; // total execution time in ms
    status: 'success' | 'failed' | 'error';
    error?: string;
}

export interface TestSummary {
    totalFeatures: number;
    totalScenarios: number;
    passed: number;
    failed: number;
    skipped: number;
    passPercentage: number;
    executionTime: string; // formatted time (e.g., "2m 15s")
}

export interface FeatureResult {
    name: string;
    relativePath: string;
    absolutePath: string;
    scenarios: ScenarioResult[];
    duration: number;
    passed: number;
    failed: number;
    skipped: number;
    status: 'passed' | 'failed' | 'skipped';
    error?: string;
}

export interface ScenarioResult {
    name: string;
    line: number; // line number in feature file
    status: 'passed' | 'failed' | 'skipped';
    steps: StepResult[];
    duration: number;
    error?: string;
    tags?: string[];
}

export interface StepResult {
    keyword: string;
    text: string;
    line?: number;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    errorMessage?: string;
    log?: string; // Full stepLog from Karate
    httpRequest?: HTTPRequestDetails;
    httpResponse?: HTTPResponseDetails;
}

export interface HTTPRequestDetails {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
}

export interface HTTPResponseDetails {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    duration?: number;
}
