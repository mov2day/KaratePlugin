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
    category?: 'positive' | 'negative' | 'edge' | 'boundary' | 'security';
    domain?: string;
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
    flakiness?: FlakinessSummary;
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

export type FlakinessTier = 'stable' | 'watch' | 'flaky' | 'broken';

export interface FlakinessTierCounts {
    stable: number;
    watch: number;
    flaky: number;
    broken: number;
}

export interface FlakinessSummary {
    threshold: number;
    thresholds: {
        watch: number;
        flaky: number;
        broken: number;
    };
    totalScenarios: number;
    flaggedCount: number;
    tierCounts: FlakinessTierCounts;
}

// Configuration Types
export interface KarateConfig {
    outputPath: string;
    useCopilot: boolean;
    testTemplate: string;
    confluence?: {
        baseUrl?: string;
        email?: string;
        authType?: 'basic' | 'bearer';
    };
    structuringStrategy?: 'flat' | 'domain' | 'atomic';
    autoTag?: boolean;
}

// Generation Types
export interface GenerationOptions {
    filePath?: string; // For OpenAPI
    pageUrl?: string; // For Confluence
    openApiPath?: string; // For Combined
    confluenceUrl?: string; // For Combined
    useCopilot: boolean;
    templateId?: string;
    scenarioTypes?: string[];
    httpMethods?: string[];
    customInstruction?: string;
}

// History Types
export interface HistoryItem {
    id: string;
    timestamp: number;
    type: 'openapi' | 'confluence' | 'combined';
    source: string; // File path or URL
    secondarySource?: string;
    outputPath: string;
    template: string;
}

// Template Types
export interface KarateTemplate {
    id: string;
    name: string;
    content: string;
    description: string;
    isCustom: boolean;
}

// Style Types
export interface KarateStyle {
    indentation: string;
    variableCase: 'camelCase' | 'snake_case';
    commentStyle: 'hash' | 'doubleSlash';
    lineSpacing: number;
}

export interface HTTPResponseDetails {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    duration?: number;
}

// Webview Message Types
export type WebviewMessage =
    | { command: 'selectOpenAPIFile' }
    | { command: 'generateFromOpenAPI'; filePath: string; useCopilot: boolean; templateId?: string; scenarioTypes?: string[]; httpMethods?: string[]; customInstruction?: string }
    | { command: 'generateFromConfluence'; pageUrl: string; useCopilot: boolean; templateId?: string }
    | { command: 'generateCombined'; openApiPath: string; confluenceUrl: string; useCopilot: boolean; templateId?: string; scenarioTypes?: string[]; httpMethods?: string[]; customInstruction?: string }
    | { command: 'getConfig' }
    | { command: 'saveConfig'; config: any }
    | { command: 'getHistory' }
    | { command: 'getTemplates' }
    | { command: 'saveTemplate'; template: any }
    | { command: 'learnStyle'; filePath?: string }
    | { command: 'openGeneratedFile'; filePath: string }
    | { command: 'copyToClipboard'; content: string }
    | { command: 'syncTests'; specPath: string; updatePlan: any }
    | { command: 'launchCoverageDashboard' };
