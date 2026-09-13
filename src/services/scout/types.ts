export type ScoutBrowser = 'chrome' | 'edge';
export type ScoutConnectionMode = 'launch' | 'companion' | 'har';
export type ScoutStatus = 'idle' | 'connecting' | 'sign-in' | 'ready' | 'teaching' | 'exploring' | 'auth-required' | 'disconnected';
export type ScoutOutcome = 'proposed' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'auth-required' | 'cancelled';

export interface ScoutCapabilities {
    actions: boolean;
    responseBodies: boolean;
    interaction: boolean;
    limitations: string[];
}

export interface ScoutConnection {
    browser: ScoutBrowser;
    mode: ScoutConnectionMode;
    url: string;
    allowedOrigins: string[];
    excludedOrigins: string[];
    executablePath?: string;
    browserVersion?: string;
}

export interface ScoutAction {
    id: string;
    timestamp: number;
    kind: 'click' | 'fill' | 'select' | 'check';
    url: string;
    selector: string;
    label: string;
    value?: string;
    field?: string;
    inputType?: string;
    constraints?: { required?: boolean; min?: number; max?: number; maxLength?: number };
}

export interface ScoutRequest {
    id: string;
    timestamp: number;
    actionId?: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    response?: { status: number; body?: unknown; headers: Record<string, string>; duration: number };
    incomplete?: string;
}

export interface ScoutDependency {
    id: string;
    fromRequestId: string;
    fromPointer: string;
    toRequestId: string;
    target: 'body' | 'path' | 'query';
    toPointer: string;
    candidates: Array<{ requestId: string; pointer: string }>;
    confirmed: boolean;
}

export interface ScoutAssertion {
    pointer: string;
    operator: 'equals' | 'at-most' | 'at-least' | 'present';
    value?: unknown;
}

export interface ScoutExpectation {
    requestId: string;
    statuses: number[];
    assertions: ScoutAssertion[];
    confirmed: boolean;
}

export interface ScoutVariant {
    id: string;
    name: string;
    source: 'observed' | 'ai' | 'manual';
    kind: 'baseline' | 'required' | 'boundary' | 'repeat';
    actionId?: string;
    value?: string;
    expectation: ScoutExpectation;
    outcome: ScoutOutcome;
    evidence: ScoutRequest[];
    message?: string;
    verifiedAt?: number;
}

export interface ScoutJourney {
    schemaVersion: 1;
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    connection: ScoutConnection;
    origin: 'browser' | 'har';
    actions: ScoutAction[];
    requests: ScoutRequest[];
    dependencies: ScoutDependency[];
    expectations: ScoutExpectation[];
    variants: ScoutVariant[];
    resetUrl?: string;
    freshDataPerRun: boolean;
    baselineConfirmed: boolean;
    verification: { browser?: { at: number; passed: boolean }; karate?: { at: number; passed: boolean; featurePath: string }; auth: 'required' | 'fixture' | 'none' };
}

export interface ScoutSnapshot {
    status: ScoutStatus;
    journey?: ScoutJourney;
    capabilities?: ScoutCapabilities;
    pairing?: { endpoint: string; token: string; expiresAt: number };
    message?: string;
    busy?: string;
    suitePath?: string;
    canResume?: boolean;
}

export type ScoutOperation = 'snapshot' | 'connect' | 'start' | 'stop' | 'disconnect' | 'cancel' | 'propose' | 'explore' | 'resume' | 'save' | 'load' | 'import-har' | 'export' | 'verify-karate' | 'companion-files' | 'demo' | 'update';

export interface ScoutCommand {
    operation: ScoutOperation;
    connection?: ScoutConnection;
    name?: string;
    useAI?: boolean;
    reconnect?: boolean;
    variantIds?: string[];
    discardVariantIds?: string[];
    resetUrl?: string;
    freshDataPerRun?: boolean;
    baselineConfirmed?: boolean;
    expectations?: ScoutExpectation[];
    variants?: ScoutVariant[];
    dependencies?: ScoutDependency[];
    auth?: 'required' | 'fixture' | 'none';
}
