import axios from 'axios';
import * as crypto from 'crypto';
import { OpenAPIEndpoint, BugFinding, BugFindingCategory, BugFindingSeverity, BugHunterOptions, BugHunterProbeReport, BugHunterRunResult } from '../../types';
import { OpenAPIParser } from '../openApiParser';
import { SmartValueGenerator } from '../data/SmartValueGenerator';
import { logger } from '../../utils/logger';

type JsonObject = Record<string, unknown>;

interface BugHunterHttpRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    params?: JsonObject;
    data?: unknown;
    timeout: number;
    validateStatus: () => boolean;
}

interface BugHunterHttpResponse {
    status: number;
    headers?: Record<string, unknown>;
    data?: unknown;
}

export interface BugHunterHttpClient {
    request(config: BugHunterHttpRequest): Promise<BugHunterHttpResponse>;
}

interface PayloadMutation {
    name: string;
    category: 'validation-bypass' | 'injection-smoke';
    body: unknown;
    expected: string;
}

interface Probe {
    name: string;
    endpoint: OpenAPIEndpoint;
    category: BugFindingCategory;
    expected: string;
    method: string;
    path: string;
    query: JsonObject;
    headers: Record<string, string>;
    body?: unknown;
    validBaseline?: boolean;
    responseSchema?: unknown;
}

interface ProbeBuildResult {
    probes: Probe[];
    skippedProbes: number;
    skippedProbeReports: BugHunterProbeReport[];
}

interface ProbeExecutionResult {
    finding: BugFinding | null;
    responseStatus: number;
    durationMs: number;
}

interface SchemaValidationResult {
    valid: boolean;
    errors: string[];
}

const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_SECRET_PATTERNS = [
    /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /Basic\s+[A-Za-z0-9._~+/=-]+/gi,
    /(api[-_]?key|token|secret|password)["']?\s*[:=]\s*["'][^"']+["']/gi
];

/**
 * Runs bounded OpenAPI-derived probes against a live API and exports
 * only interesting findings as Karate regression scenarios.
 */
export class ApiBugHunterService {
    private parser = new OpenAPIParser();

    constructor(private httpClient: BugHunterHttpClient = axios as BugHunterHttpClient) { }

    async hunt(specPath: string, options: BugHunterOptions): Promise<BugHunterRunResult> {
        const startedAt = Date.now();
        const endpoints = await this.parser.parseSpec(specPath);
        const buildResult = this.buildProbes(endpoints, options);
        const maxRequests = Math.max(0, options.maxRequests);
        const probes = buildResult.probes.slice(0, maxRequests);
        const cappedProbeReports = buildResult.probes
            .slice(maxRequests)
            .map((probe) => this.toProbeReport(probe, 'skipped', `Skipped by maxRequests cap (${maxRequests})`));
        const probeReports: BugHunterProbeReport[] = [
            ...buildResult.skippedProbeReports,
            ...cappedProbeReports
        ];
        const findings: BugFinding[] = [];
        let completed = 0;
        const totalProbes = buildResult.probes.length + buildResult.skippedProbes;

        logger.info(`API Bug Hunter: built ${totalProbes} probe candidates, executing ${probes.length}`);

        await this.runWithConcurrency(probes, Math.max(1, options.concurrency), async (probe) => {
            const result = await this.executeProbe(probe, options);
            completed++;
            options.onProgress?.(completed, probes.length, probe.name);
            probeReports.push(this.toProbeReport(probe, 'executed', undefined, result.responseStatus, result.durationMs, result.finding?.id));
            if (result.finding) {
                findings.push(result.finding);
            }
        });

        return {
            specPath,
            baseUrl: options.baseUrl,
            totalProbes,
            executedProbes: probes.length,
            skippedProbes: probeReports.filter((probe) => probe.status === 'skipped').length,
            probes: probeReports,
            findings,
            startedAt,
            completedAt: Date.now(),
            reproFeature: this.generateReproFeature(findings, options.baseUrl)
        };
    }

    buildProbes(endpoints: OpenAPIEndpoint[], options: BugHunterOptions): ProbeBuildResult {
        const probes: Probe[] = [];
        let skippedProbes = 0;
        const skippedProbeReports: BugHunterProbeReport[] = [];

        for (const endpoint of endpoints) {
            const method = endpoint.method.toUpperCase();
            const allowed = this.isMethodAllowed(method, options);
            if (!allowed) {
                skippedProbes++;
                skippedProbeReports.push({
                    name: `${method} ${endpoint.path}`,
                    method,
                    path: endpoint.path,
                    status: 'skipped',
                    reason: options.safeMode
                        ? 'Skipped destructive method while safe mode is enabled'
                        : 'Skipped destructive method because includeDestructiveMethods is false'
                });
                continue;
            }

            const pathValues = this.buildPathValues(endpoint);
            const query = this.buildQuery(endpoint);
            const path = this.resolvePath(endpoint.path, pathValues);
            const requestSchema = this.extractRequestSchema(endpoint);
            const responseSchema = this.extractSuccessResponseSchema(endpoint);
            const baseHeaders = this.buildHeaders(options.authHeader, requestSchema !== undefined);

            probes.push({
                name: `${method} ${endpoint.path} baseline`,
                endpoint,
                category: 'schema-drift',
                expected: 'Response matches the OpenAPI response schema and avoids 5xx',
                method,
                path,
                query,
                headers: baseHeaders,
                body: requestSchema ? this.buildBaselinePayload(requestSchema) : undefined,
                validBaseline: true,
                responseSchema
            });

            if (requestSchema) {
                for (const mutation of this.buildPayloadMutations(requestSchema)) {
                    probes.push({
                        name: `${method} ${endpoint.path} ${mutation.name}`,
                        endpoint,
                        category: mutation.category,
                        expected: mutation.expected,
                        method,
                        path,
                        query,
                        headers: baseHeaders,
                        body: mutation.body
                    });
                }
            }

            if (options.authHeader) {
                probes.push({
                    name: `${method} ${endpoint.path} without auth`,
                    endpoint,
                    category: 'auth-missing',
                    expected: 'Missing authentication should return 401 or 403',
                    method,
                    path,
                    query,
                    headers: this.buildHeaders(undefined, requestSchema !== undefined),
                    body: requestSchema ? this.buildBaselinePayload(requestSchema) : undefined
                });
            }

            const swappedPath = this.buildSwappedIdPath(endpoint.path);
            if (options.authHeader && swappedPath && method === 'GET') {
                probes.push({
                    name: `${method} ${endpoint.path} swapped id`,
                    endpoint,
                    category: 'bola-smoke',
                    expected: 'Swapped object id should not expose another resource',
                    method,
                    path: swappedPath,
                    query,
                    headers: baseHeaders
                });
            }
        }

        return { probes, skippedProbes, skippedProbeReports };
    }

    buildBaselinePayload(schema: unknown, fieldName: string = ''): unknown {
        return SmartValueGenerator.generate(fieldName, schema);
    }

    buildPayloadMutations(schema: unknown): PayloadMutation[] {
        const baseline = this.buildBaselinePayload(schema);
        const mutations: PayloadMutation[] = [];

        if (!this.isObjectSchema(schema) || !this.isPlainObject(baseline)) {
            mutations.push({
                name: 'wrong type payload',
                category: 'validation-bypass',
                body: 'not-an-object',
                expected: 'Wrong payload type should return 400 or 422'
            });
            mutations.push({
                name: 'injection payload',
                category: 'injection-smoke',
                body: "' OR '1'='1",
                expected: 'Injection payload should not cause 5xx or unsafe echo'
            });
            return mutations;
        }

        const schemaObject = schema as { properties?: Record<string, unknown>; required?: string[] };
        const required = schemaObject.required || [];
        const properties = schemaObject.properties || {};
        const propertyNames = Object.keys(properties);
        const firstRequired = required.find((name) => Object.prototype.hasOwnProperty.call(baseline, name));
        const firstProperty = propertyNames.find((name) => Object.prototype.hasOwnProperty.call(baseline, name));

        if (firstRequired) {
            const missing = { ...baseline };
            delete missing[firstRequired];
            mutations.push({
                name: `missing required ${firstRequired}`,
                category: 'validation-bypass',
                body: missing,
                expected: `Missing required field "${firstRequired}" should return 400 or 422`
            });

            mutations.push({
                name: `null required ${firstRequired}`,
                category: 'validation-bypass',
                body: { ...baseline, [firstRequired]: null },
                expected: `Null required field "${firstRequired}" should return 400 or 422`
            });
        }

        if (firstProperty) {
            mutations.push({
                name: `wrong type ${firstProperty}`,
                category: 'validation-bypass',
                body: { ...baseline, [firstProperty]: this.wrongTypeValue(properties[firstProperty]) },
                expected: `Wrong type for "${firstProperty}" should return 400 or 422`
            });
        }

        const enumField = propertyNames.find((name) => this.schemaHasEnum(properties[name]));
        if (enumField) {
            mutations.push({
                name: `invalid enum ${enumField}`,
                category: 'validation-bypass',
                body: { ...baseline, [enumField]: '__invalid_enum_value__' },
                expected: `Invalid enum value for "${enumField}" should return 400 or 422`
            });
        }

        const boundaryField = propertyNames.find((name) => this.canOverflow(properties[name]));
        if (boundaryField) {
            mutations.push({
                name: `boundary overflow ${boundaryField}`,
                category: 'validation-bypass',
                body: { ...baseline, [boundaryField]: this.overflowValue(properties[boundaryField]) },
                expected: `Boundary overflow for "${boundaryField}" should return 400 or 422`
            });
        }

        const stringField = propertyNames.find((name) => this.schemaType(properties[name]) === 'string') || firstProperty;
        if (stringField) {
            mutations.push({
                name: `oversized string ${stringField}`,
                category: 'validation-bypass',
                body: { ...baseline, [stringField]: 'A'.repeat(1024) },
                expected: `Oversized value for "${stringField}" should return 400 or 422`
            });

            mutations.push({
                name: `injection string ${stringField}`,
                category: 'injection-smoke',
                body: { ...baseline, [stringField]: "<script>alert('x')</script>' OR '1'='1" },
                expected: 'Injection-like payload should not cause 5xx or unsafe echo'
            });
        }

        return mutations.slice(0, 8);
    }

    validateAgainstSchema(value: unknown, schema: unknown): SchemaValidationResult {
        const errors: string[] = [];
        this.validateNode(value, schema, '$', errors);
        return { valid: errors.length === 0, errors };
    }

    generateReproFeature(findings: BugFinding[], baseUrl: string): string {
        if (findings.length === 0) {
            return '';
        }

        const lines: string[] = [];
        lines.push('Feature: API Bug Hunter Reproductions');
        lines.push('');
        lines.push('  Background:');
        lines.push(`    * def baseUrl = karate.properties['baseUrl'] || '${this.escapeSingleQuoted(baseUrl)}'`);
        lines.push('    * url baseUrl');
        lines.push(`    * def authHeader = karate.properties['authHeader'] || '<set authHeader if required>'`);
        lines.push('');

        for (const finding of findings) {
            lines.push(finding.karateScenario);
            lines.push('');
        }

        return lines.join('\n').trimEnd() + '\n';
    }

    static redactSecrets(value: unknown, authHeader?: string): string {
        let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        if (!text) {
            return '';
        }

        if (authHeader) {
            text = text.split(authHeader).join('<redacted>');
        }

        for (const pattern of AUTH_SECRET_PATTERNS) {
            text = text.replace(pattern, (match) => {
                const separator = match.includes(':') ? ':' : '=';
                if (match.includes(separator) && !/^Bearer|^Basic/i.test(match)) {
                    return `${match.split(separator)[0]}${separator}"<redacted>"`;
                }
                return match.split(/\s+/)[0] + ' <redacted>';
            });
        }

        return text;
    }

    private async executeProbe(probe: Probe, options: BugHunterOptions): Promise<ProbeExecutionResult> {
        const request = this.toHttpRequest(probe, options);
        const start = Date.now();

        try {
            const response = await this.httpClient.request(request);
            const durationMs = Date.now() - start;
            return {
                finding: this.classifyFinding(probe, request, response, durationMs, options),
                responseStatus: response.status,
                durationMs
            };
        } catch (error) {
            const durationMs = Date.now() - start;
            const response: BugHunterHttpResponse = {
                status: 0,
                headers: {},
                data: (error as Error).message
            };

            return {
                finding: this.createFinding(
                    probe,
                    'high',
                    'server-crash',
                    'Probe should complete without transport errors',
                    `Transport error: ${(error as Error).message}`,
                    request,
                    response,
                    durationMs,
                    options
                ),
                responseStatus: response.status,
                durationMs
            };
        }
    }

    private toProbeReport(
        probe: Probe,
        status: BugHunterProbeReport['status'],
        reason?: string,
        responseStatus?: number,
        durationMs?: number,
        findingId?: string
    ): BugHunterProbeReport {
        return {
            name: probe.name,
            method: probe.method,
            path: probe.path,
            category: probe.category,
            status,
            reason,
            responseStatus,
            durationMs,
            findingId
        };
    }

    private classifyFinding(
        probe: Probe,
        request: BugHunterHttpRequest,
        response: BugHunterHttpResponse,
        durationMs: number,
        options: BugHunterOptions
    ): BugFinding | null {
        const status = response.status;

        if (status >= 500) {
            return this.createFinding(
                probe,
                'high',
                'server-crash',
                probe.expected,
                `Received ${status}`,
                request,
                response,
                durationMs,
                options
            );
        }

        if (probe.category === 'auth-missing' && this.isSuccess(status)) {
            return this.createFinding(probe, 'high', 'auth-missing', probe.expected, `Received ${status}`, request, response, durationMs, options);
        }

        if (probe.category === 'bola-smoke' && this.isSuccess(status)) {
            return this.createFinding(probe, 'medium', 'bola-smoke', probe.expected, `Received ${status}`, request, response, durationMs, options);
        }

        if (probe.category === 'validation-bypass' && this.isSuccess(status)) {
            return this.createFinding(probe, 'medium', 'validation-bypass', probe.expected, `Received ${status}`, request, response, durationMs, options);
        }

        if (probe.category === 'injection-smoke') {
            const responseText = ApiBugHunterService.redactSecrets(response.data, options.authHeader);
            if (this.isSuccess(status) && responseText.includes('<script>')) {
                return this.createFinding(
                    probe,
                    'medium',
                    'injection-smoke',
                    probe.expected,
                    'Response echoed script-like payload',
                    request,
                    response,
                    durationMs,
                    options
                );
            }
        }

        if (probe.validBaseline && probe.responseSchema && this.isSuccess(status)) {
            const validation = this.validateAgainstSchema(response.data, probe.responseSchema);
            if (!validation.valid) {
                return this.createFinding(
                    probe,
                    'medium',
                    'schema-drift',
                    'Response matches OpenAPI response schema',
                    validation.errors[0],
                    request,
                    response,
                    durationMs,
                    options
                );
            }
        }

        return null;
    }

    private createFinding(
        probe: Probe,
        severity: BugFindingSeverity,
        category: BugFindingCategory,
        expected: string,
        observed: string,
        request: BugHunterHttpRequest,
        response: BugHunterHttpResponse,
        durationMs: number,
        options: BugHunterOptions
    ): BugFinding {
        const sanitizedRequest = {
            method: request.method,
            url: request.url,
            path: probe.path,
            headers: this.redactHeaderRecord(request.headers, options.authHeader),
            query: request.params,
            body: request.data,
            probeName: probe.name
        };
        const sanitizedResponse = {
            status: response.status,
            headers: this.redactHeaderRecord(this.normalizeHeaders(response.headers), options.authHeader),
            body: this.redactBody(response.data, options.authHeader),
            durationMs
        };

        const finding: BugFinding = {
            id: this.findingId(probe, category, observed),
            severity,
            category,
            endpoint: {
                method: probe.endpoint.method.toUpperCase(),
                path: probe.endpoint.path,
                operationId: probe.endpoint.operationId
            },
            expected,
            observed,
            request: sanitizedRequest,
            response: sanitizedResponse,
            curl: this.toCurl(sanitizedRequest),
            karateScenario: ''
        };

        finding.karateScenario = this.toKarateScenario(finding, probe);
        return finding;
    }

    private toHttpRequest(probe: Probe, options: BugHunterOptions): BugHunterHttpRequest {
        return {
            method: probe.method,
            url: this.joinUrl(options.baseUrl, probe.path),
            headers: probe.headers,
            params: probe.query,
            data: probe.body,
            timeout: Math.max(500, options.timeoutMs),
            validateStatus: () => true
        };
    }

    private buildHeaders(authHeader: string | undefined, hasBody: boolean): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: 'application/json'
        };

        if (hasBody) {
            headers['Content-Type'] = 'application/json';
        }

        if (authHeader) {
            headers.Authorization = authHeader;
        }

        return headers;
    }

    private buildPathValues(endpoint: OpenAPIEndpoint): JsonObject {
        const values: JsonObject = {};
        const pathParams = endpoint.parameters?.filter((param) => param.in === 'path') || [];
        for (const param of pathParams) {
            values[param.name] = SmartValueGenerator.generate(param.name, param.schema || { type: 'string' });
        }
        return values;
    }

    private buildQuery(endpoint: OpenAPIEndpoint): JsonObject {
        const query: JsonObject = {};
        const queryParams = endpoint.parameters?.filter((param) => param.in === 'query' && param.required) || [];
        for (const param of queryParams) {
            query[param.name] = SmartValueGenerator.generate(param.name, param.schema || { type: 'string' });
        }
        return query;
    }

    private resolvePath(pathTemplate: string, values: JsonObject): string {
        return pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(values[name] ?? '1')));
    }

    private buildSwappedIdPath(pathTemplate: string): string | null {
        if (!/\{[^}]*id[^}]*\}/i.test(pathTemplate) && !/\{[^}]+\}/.test(pathTemplate)) {
            return null;
        }
        return pathTemplate.replace(/\{[^}]+\}/g, '999999999');
    }

    private extractRequestSchema(endpoint: OpenAPIEndpoint): unknown {
        const content = endpoint.requestBody?.content;
        if (!content) {
            return undefined;
        }
        return content['application/json']?.schema || Object.values(content)[0]?.schema;
    }

    private extractSuccessResponseSchema(endpoint: OpenAPIEndpoint): unknown {
        const responses = endpoint.responses || {};
        const successCode = Object.keys(responses).find((code) => code.startsWith('2'));
        const response = successCode ? responses[successCode] : undefined;
        const content = response?.content;
        if (!content) {
            return undefined;
        }
        return content['application/json']?.schema || Object.values(content)[0]?.schema;
    }

    private isMethodAllowed(method: string, options: BugHunterOptions): boolean {
        if (!DESTRUCTIVE_METHODS.has(method)) {
            return true;
        }
        return !options.safeMode && options.includeDestructiveMethods;
    }

    private isSuccess(status: number): boolean {
        return status >= 200 && status < 300;
    }

    private isObjectSchema(schema: unknown): schema is { type?: string; properties?: Record<string, unknown> } {
        return this.isPlainObject(schema) && ((schema as { type?: string }).type === 'object' || !!(schema as { properties?: unknown }).properties);
    }

    private isPlainObject(value: unknown): value is JsonObject {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private schemaType(schema: unknown): string {
        if (!this.isPlainObject(schema)) {
            return '';
        }
        return String(schema.type || '');
    }

    private schemaHasEnum(schema: unknown): boolean {
        return this.isPlainObject(schema) && Array.isArray(schema.enum) && schema.enum.length > 0;
    }

    private canOverflow(schema: unknown): boolean {
        if (!this.isPlainObject(schema)) {
            return false;
        }
        const type = this.schemaType(schema);
        return type === 'integer' || type === 'number' || schema.maximum !== undefined || schema.exclusiveMaximum !== undefined;
    }

    private overflowValue(schema: unknown): number {
        if (!this.isPlainObject(schema)) {
            return Number.MAX_SAFE_INTEGER;
        }
        if (typeof schema.exclusiveMaximum === 'number') {
            return schema.exclusiveMaximum + 1;
        }
        if (typeof schema.maximum === 'number') {
            return schema.maximum + 1;
        }
        if (typeof schema.minimum === 'number') {
            return schema.minimum - 1;
        }
        return Number.MAX_SAFE_INTEGER;
    }

    private wrongTypeValue(schema: unknown): unknown {
        const type = this.schemaType(schema);
        switch (type) {
            case 'string':
                return 12345;
            case 'integer':
            case 'number':
                return 'not-a-number';
            case 'boolean':
                return 'not-a-boolean';
            case 'array':
                return 'not-an-array';
            case 'object':
                return 'not-an-object';
            default:
                return { unexpected: true };
        }
    }

    private validateNode(value: unknown, schema: unknown, location: string, errors: string[]): void {
        if (!schema || !this.isPlainObject(schema)) {
            return;
        }

        if (schema.nullable === true && value === null) {
            return;
        }

        const type = this.schemaType(schema);
        if (type && !this.matchesType(value, type)) {
            errors.push(`${location}: expected ${type}, got ${Array.isArray(value) ? 'array' : typeof value}`);
            return;
        }

        if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
            errors.push(`${location}: expected one of ${schema.enum.join(', ')}`);
        }

        if (type === 'object' || schema.properties) {
            if (!this.isPlainObject(value)) {
                errors.push(`${location}: expected object`);
                return;
            }
            const required = Array.isArray(schema.required) ? schema.required as string[] : [];
            for (const field of required) {
                if (value[field] === undefined) {
                    errors.push(`${location}.${field}: missing required field`);
                }
            }
            const properties = this.isPlainObject(schema.properties) ? schema.properties : {};
            for (const [field, childSchema] of Object.entries(properties)) {
                if (value[field] !== undefined) {
                    this.validateNode(value[field], childSchema, `${location}.${field}`, errors);
                }
            }
        }

        if (type === 'array') {
            if (!Array.isArray(value)) {
                errors.push(`${location}: expected array`);
                return;
            }
            const itemSchema = schema.items;
            if (itemSchema) {
                value.slice(0, 5).forEach((item, index) => this.validateNode(item, itemSchema, `${location}[${index}]`, errors));
            }
        }
    }

    private matchesType(value: unknown, type: string): boolean {
        switch (type) {
            case 'string':
                return typeof value === 'string';
            case 'integer':
                return typeof value === 'number' && Number.isInteger(value);
            case 'number':
                return typeof value === 'number';
            case 'boolean':
                return typeof value === 'boolean';
            case 'array':
                return Array.isArray(value);
            case 'object':
                return this.isPlainObject(value);
            default:
                return true;
        }
    }

    private toCurl(request: BugFinding['request']): string {
        const parts = [`curl -i -X ${request.method}`];
        for (const [key, value] of Object.entries(request.headers)) {
            parts.push(`-H '${this.escapeSingleQuoted(key)}: ${this.escapeSingleQuoted(String(value))}'`);
        }
        if (request.body !== undefined) {
            parts.push(`--data '${this.escapeSingleQuoted(JSON.stringify(request.body))}'`);
        }
        parts.push(`'${this.escapeSingleQuoted(request.url)}'`);
        return parts.join(' ');
    }

    private toKarateScenario(finding: BugFinding, probe: Probe): string {
        const lines: string[] = [];
        const tag = finding.category.replace(/-/g, '_');
        lines.push(`  @bug @${tag}`);
        lines.push(`  Scenario: ${this.sanitizeScenarioName(finding.category, finding.endpoint.method, finding.endpoint.path)}`);
        lines.push(`    # Expected: ${finding.expected}`);
        lines.push(`    # Observed: ${finding.observed}`);
        lines.push(...this.pathToKarateSteps(probe.path));

        if (Object.keys(probe.query).length > 0) {
            for (const [key, value] of Object.entries(probe.query)) {
                lines.push(`    And param ${key} = ${JSON.stringify(value)}`);
            }
        }

        if (finding.request.headers.Authorization) {
            lines.push('    And header Authorization = authHeader');
        }

        if (probe.body !== undefined) {
            lines.push('    And request');
            lines.push('      """');
            lines.push(this.indent(JSON.stringify(probe.body, null, 2), 6));
            lines.push('      """');
        }

        lines.push(`    When method ${finding.endpoint.method.toUpperCase()}`);
        lines.push(...this.assertionForFinding(finding, probe));
        return lines.join('\n');
    }

    private assertionForFinding(finding: BugFinding, probe: Probe): string[] {
        switch (finding.category) {
            case 'server-crash':
                return ['    Then assert responseStatus < 500'];
            case 'validation-bypass':
                return ['    Then assert responseStatus >= 400'];
            case 'auth-missing':
                return ['    Then assert responseStatus == 401 || responseStatus == 403'];
            case 'bola-smoke':
                return ['    Then assert responseStatus == 403 || responseStatus == 404'];
            case 'injection-smoke':
                return ['    Then assert responseStatus < 500', "    And assert !karate.pretty(response).contains('<script>')"];
            case 'schema-drift':
                if (probe.responseSchema) {
                    return ['    Then status 200', `    And match response == ${this.schemaToKarateMatcher(probe.responseSchema)}`];
                }
                return ['    Then status 200'];
            default:
                return ['    Then assert responseStatus < 500'];
        }
    }

    private schemaToKarateMatcher(schema: unknown): string {
        if (!this.isPlainObject(schema)) {
            return "'#present'";
        }

        const type = this.schemaType(schema);
        if (type === 'array') {
            return `'#[] ${this.schemaToKarateMatcher(schema.items)}'`;
        }
        if (type === 'object' || schema.properties) {
            const properties = this.isPlainObject(schema.properties) ? schema.properties : {};
            const entries = Object.entries(properties).map(([key, child]) => `"${key}": ${this.schemaToKarateMatcher(child)}`);
            return `{ ${entries.join(', ')} }`;
        }
        if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
            return JSON.stringify(schema.enum[0]);
        }

        switch (type) {
            case 'string':
                return "'#string'";
            case 'integer':
            case 'number':
                return "'#number'";
            case 'boolean':
                return "'#boolean'";
            default:
                return "'#present'";
        }
    }

    private pathToKarateSteps(pathValue: string): string[] {
        const parts = pathValue.split('/').filter(Boolean);
        if (parts.length === 0) {
            return ["    Given path ''"];
        }
        const quoted = parts.map((part) => `'${this.escapeSingleQuoted(decodeURIComponent(part))}'`).join(', ');
        return [`    Given path ${quoted}`];
    }

    private sanitizeScenarioName(category: string, method: string, pathValue: string): string {
        return `${category} ${method.toUpperCase()} ${pathValue}`.replace(/\s+/g, ' ').trim();
    }

    private redactHeaderRecord(headers: Record<string, unknown>, authHeader?: string): Record<string, string> {
        const redacted: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            redacted[key] = key.toLowerCase() === 'authorization'
                ? '<redacted>'
                : ApiBugHunterService.redactSecrets(String(value), authHeader);
        }
        return redacted;
    }

    private redactBody(body: unknown, authHeader?: string): unknown {
        if (body === undefined || body === null) {
            return body;
        }
        if (typeof body === 'string') {
            return ApiBugHunterService.redactSecrets(body, authHeader);
        }
        return JSON.parse(ApiBugHunterService.redactSecrets(body, authHeader));
    }

    private normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
        if (!headers) {
            return {};
        }
        const normalized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(headers)) {
            normalized[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        return normalized;
    }

    private joinUrl(baseUrl: string, pathValue: string): string {
        const base = baseUrl.replace(/\/+$/, '');
        const suffix = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
        return `${base}${suffix}`;
    }

    private findingId(probe: Probe, category: string, observed: string): string {
        const raw = `${probe.method}:${probe.path}:${category}:${observed}`;
        return `bug_${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
    }

    private indent(text: string, spaces: number): string {
        const padding = ' '.repeat(spaces);
        return text.split('\n').map((line) => `${padding}${line}`).join('\n');
    }

    private escapeSingleQuoted(value: string): string {
        return value.replace(/'/g, "\\'");
    }

    private async runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
        const queue = [...items];
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                if (item) {
                    await worker(item);
                }
            }
        });
        await Promise.all(workers);
    }
}
