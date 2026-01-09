import { PostmanRequest, PostmanAuth, PostmanBody, PostmanHeader, PostmanQueryParam, PostmanVariable } from './postmanParser';
import { logger } from '../utils/logger';

/**
 * Converts Postman requests to Karate DSL format
 */
export class PostmanToKarateConverter {

    /**
     * Convert a Postman request to a Karate scenario
     */
    public async convertRequestAsync(
        request: PostmanRequest,
        scenarioName: string,
        variables: Map<string, string> = new Map(),
        preRequestScript?: string,
        testScript?: string,
        useCopilot: boolean = false
    ): Promise<string> {
        const lines: string[] = [];

        // Scenario header
        lines.push(`  Scenario: ${scenarioName}`);

        // Add description if present
        if (request.description) {
            lines.push(`    # ${request.description}`);
        }

        // Convert pre-request script to Karate (if possible)
        if (preRequestScript) {
            const karatePreScript = useCopilot
                ? await this.convertPreRequestScriptWithCopilot(preRequestScript)
                : this.convertPreRequestScript(preRequestScript);
            if (karatePreScript) {
                lines.push(...karatePreScript.split('\\n').map(l => `    ${l}`));
            }
        }

        // Parse URL
        const url = typeof request.url === 'string' ? request.url : request.url.raw;
        const urlParts = this.parseUrlForKarate(url, variables);

        // Set base URL
        lines.push(`    Given url ${urlParts.baseUrl}`);

        // Set path
        if (urlParts.path) {
            lines.push(`    And path ${urlParts.path}`);
        }

        // Set query parameters
        if (typeof request.url !== 'string' && request.url.query) {
            for (const param of request.url.query) {
                if (!param.disabled) {
                    const value = this.replaceVariables(param.value, variables);
                    lines.push(`    And param ${param.key} = ${this.formatValue(value)}`);
                }
            }
        }

        // Set headers
        if (request.header) {
            for (const header of request.header) {
                if (!header.disabled) {
                    const value = this.replaceVariables(header.value, variables);
                    lines.push(`    And header ${header.key} = ${this.formatValue(value)}`);
                }
            }
        }

        // Set authentication
        if (request.auth) {
            const authLines = this.convertAuth(request.auth, variables);
            lines.push(...authLines.map(l => `    ${l}`));
        }

        // Set request body
        if (request.body) {
            const bodyLines = this.convertBody(request.body, variables);
            lines.push(...bodyLines.map(l => `    ${l}`));
        }

        // Execute request
        lines.push(`    When method ${request.method.toUpperCase()}`);

        // Convert test script to assertions
        if (testScript) {
            const assertions = useCopilot
                ? await this.convertTestScriptWithCopilot(testScript, request, variables)
                : this.convertTestScript(testScript, variables);
            lines.push(...assertions.map(l => `    ${l}`));
        } else {
            // Default assertion
            lines.push(`    Then status 200`);
        }

        return lines.join('\\n');
    }

    /**
     * Convert a Postman request to a Karate scenario (synchronous version for backward compatibility)
     */
    public convertRequest(
        request: PostmanRequest,
        scenarioName: string,
        variables: Map<string, string> = new Map(),
        preRequestScript?: string,
        testScript?: string
    ): string {
        const lines: string[] = [];

        // Scenario header
        lines.push(`  Scenario: ${scenarioName}`);

        // Add description if present
        if (request.description) {
            lines.push(`    # ${request.description}`);
        }

        // Convert pre-request script to Karate (if possible)
        if (preRequestScript) {
            const karatePreScript = this.convertPreRequestScript(preRequestScript);
            if (karatePreScript) {
                lines.push(...karatePreScript.split('\n').map(l => `    ${l}`));
            }
        }

        // Parse URL
        const url = typeof request.url === 'string' ? request.url : request.url.raw;
        const urlParts = this.parseUrlForKarate(url, variables);

        // Set base URL
        lines.push(`    Given url ${urlParts.baseUrl}`);

        // Set path
        if (urlParts.path) {
            lines.push(`    And path ${urlParts.path}`);
        }

        // Set query parameters
        if (typeof request.url !== 'string' && request.url.query) {
            for (const param of request.url.query) {
                if (!param.disabled) {
                    const value = this.replaceVariables(param.value, variables);
                    lines.push(`    And param ${param.key} = ${this.formatValue(value)}`);
                }
            }
        }

        // Set headers
        if (request.header) {
            for (const header of request.header) {
                if (!header.disabled) {
                    const value = this.replaceVariables(header.value, variables);
                    lines.push(`    And header ${header.key} = ${this.formatValue(value)}`);
                }
            }
        }

        // Set authentication
        if (request.auth) {
            const authLines = this.convertAuth(request.auth, variables);
            lines.push(...authLines.map(l => `    ${l}`));
        }

        // Set request body
        if (request.body) {
            const bodyLines = this.convertBody(request.body, variables);
            lines.push(...bodyLines.map(l => `    ${l}`));
        }

        // Execute request
        lines.push(`    When method ${request.method.toUpperCase()}`);

        // Convert test script to assertions
        if (testScript) {
            const assertions = this.convertTestScript(testScript, variables);
            lines.push(...assertions.map(l => `    ${l}`));
        } else {
            // Default assertion
            lines.push(`    Then status 200`);
        }

        return lines.join('\n');
    }

    /**
     * Parse URL and extract base URL and path
     */
    private parseUrlForKarate(url: string, variables: Map<string, string>): { baseUrl: string; path: string } {
        // Replace Postman variables {{var}} with Karate variables
        let processedUrl = this.replaceVariables(url, variables);

        try {
            const urlObj = new URL(processedUrl);
            const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
            const path = urlObj.pathname.split('/').filter(p => p).map(p => `'${p}'`).join(', ');

            return { baseUrl: `'${baseUrl}'`, path };
        } catch {
            // If URL parsing fails, treat as variable
            return { baseUrl: processedUrl, path: '' };
        }
    }

    /**
     * Replace Postman variables {{var}} with Karate variables
     */
    private replaceVariables(text: string, variables: Map<string, string>): string {
        return text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
            if (variables.has(varName)) {
                return variables.get(varName)!;
            }
            // Convert to Karate variable syntax
            return `#(${varName})`;
        });
    }

    /**
     * Format value for Karate (add quotes if needed)
     */
    private formatValue(value: string): string {
        // If it's already a Karate variable, don't quote
        if (value.startsWith('#(')) {
            return value;
        }
        // If it's a number, don't quote
        if (!isNaN(Number(value))) {
            return value;
        }
        // Otherwise, quote it
        return `'${value}'`;
    }

    /**
     * Convert Postman authentication to Karate
     */
    private convertAuth(auth: PostmanAuth, variables: Map<string, string>): string[] {
        const lines: string[] = [];

        switch (auth.type) {
            case 'basic':
                if (auth.basic) {
                    const username = this.getAuthValue(auth.basic, 'username', variables);
                    const password = this.getAuthValue(auth.basic, 'password', variables);
                    lines.push(`And configure headers = { Authorization: 'Basic ' + karate.encode('${username}:${password}') }`);
                }
                break;

            case 'bearer':
                if (auth.bearer) {
                    const token = this.getAuthValue(auth.bearer, 'token', variables);
                    lines.push(`And header Authorization = 'Bearer ${token}'`);
                }
                break;

            case 'apikey':
                if (auth.apikey) {
                    const key = this.getAuthValue(auth.apikey, 'key', variables);
                    const value = this.getAuthValue(auth.apikey, 'value', variables);
                    const inValue = this.getAuthValue(auth.apikey, 'in', variables);

                    if (inValue === 'header') {
                        lines.push(`And header ${key} = '${value}'`);
                    } else {
                        lines.push(`And param ${key} = '${value}'`);
                    }
                }
                break;

            case 'oauth2':
                lines.push(`# OAuth2 authentication - configure manually`);
                break;
        }

        return lines;
    }

    /**
     * Get auth value from Postman auth array
     */
    private getAuthValue(authArray: Array<{ key: string; value: string }>, key: string, variables: Map<string, string>): string {
        const item = authArray.find(a => a.key === key);
        return item ? this.replaceVariables(item.value, variables) : '';
    }

    /**
     * Convert request body to Karate
     */
    private convertBody(body: PostmanBody, variables: Map<string, string>): string[] {
        const lines: string[] = [];

        switch (body.mode) {
            case 'raw':
                if (body.raw) {
                    const processedBody = this.replaceVariables(body.raw, variables);

                    // Check if it's JSON
                    if (body.options?.raw?.language === 'json' || this.isJson(processedBody)) {
                        try {
                            const jsonObj = JSON.parse(processedBody);
                            lines.push(`And request ${JSON.stringify(jsonObj, null, 2)}`);
                        } catch {
                            lines.push(`And request ${processedBody}`);
                        }
                    } else {
                        lines.push(`And request ${this.formatValue(processedBody)}`);
                    }
                }
                break;

            case 'urlencoded':
                if (body.urlencoded) {
                    const formData: any = {};
                    for (const param of body.urlencoded) {
                        if (!param.disabled) {
                            formData[param.key] = this.replaceVariables(param.value, variables);
                        }
                    }
                    lines.push(`And form fields ${JSON.stringify(formData)}`);
                }
                break;

            case 'formdata':
                if (body.formdata) {
                    const formData: any = {};
                    for (const param of body.formdata) {
                        if (!param.disabled) {
                            if (param.type === 'file') {
                                lines.push(`And multipart file ${param.key} = { read: '${param.value}' }`);
                            } else {
                                formData[param.key] = this.replaceVariables(param.value, variables);
                            }
                        }
                    }
                    if (Object.keys(formData).length > 0) {
                        lines.push(`And multipart fields ${JSON.stringify(formData)}`);
                    }
                }
                break;
        }

        return lines;
    }

    /**
     * Check if string is valid JSON
     */
    private isJson(str: string): boolean {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Convert Postman test script to Karate assertions
     */
    private convertTestScript(script: string, variables: Map<string, string>): string[] {
        const assertions: string[] = [];
        const lines = script.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // Status code assertions
            if (trimmed.includes('pm.response.to.have.status')) {
                const match = trimmed.match(/status\((\d+)\)/);
                if (match) {
                    assertions.push(`Then status ${match[1]}`);
                }
            }

            // Response time assertions
            else if (trimmed.includes('pm.expect(pm.response.responseTime)')) {
                const match = trimmed.match(/below\((\d+)\)/);
                if (match) {
                    assertions.push(`And assert responseTime < ${match[1]}`);
                }
            }

            // JSON body assertions
            else if (trimmed.includes('pm.expect(') && trimmed.includes('jsonData')) {
                const converted = this.convertJsonAssertion(trimmed);
                if (converted) {
                    assertions.push(converted);
                }
            }

            // Header assertions
            else if (trimmed.includes('pm.response.to.have.header')) {
                const match = trimmed.match(/header\(['"]([^'"]+)['"]\)/);
                if (match) {
                    assertions.push(`And match header ${match[1]} == '#present'`);
                }
            }

            // Content-Type assertions
            else if (trimmed.includes('pm.response.to.be.json')) {
                assertions.push(`And match header Content-Type contains 'json'`);
            }
        }

        // If no assertions were converted, add default
        if (assertions.length === 0) {
            assertions.push(`Then status 200`);
            assertions.push(`# Original test script:`);
            assertions.push(...script.split('\n').map(l => `# ${l}`));
        }

        return assertions;
    }

    /**
     * Convert Postman test script to Karate assertions using Copilot
     */
    private async convertTestScriptWithCopilot(
        script: string,
        request: PostmanRequest,
        variables: Map<string, string>
    ): Promise<string[]> {
        try {
            const { CopilotService } = await import('./copilotService');

            const prompt = `Convert this Postman test script to Karate DSL assertions.

Postman Test Script:
\`\`\`javascript
${script}
\`\`\`

API Endpoint: ${request.method} ${request.url}

Requirements:
1. Convert ALL assertions (status, response time, headers, body)
2. Use proper Karate match syntax for JSON validation
3. Use JSONPath for nested field validation
4. Include schema validation where applicable
5. Convert pm.expect() to Karate match statements
6. Handle array validations properly
7. Add response time assertions if present
8. Validate headers using 'match header'

Return ONLY the Karate assertion lines (Then/And statements), one per line.`;

            const models = await import('vscode').then(m => m.default.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' }));
            if (models.length === 0) {
                return this.convertTestScript(script, variables);
            }

            const model = models[0];
            const vscode = await import('vscode');
            const messages = [vscode.default.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {}, new vscode.default.CancellationTokenSource().token);

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            // Parse the response into assertion lines
            const assertions = result
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('Then') || line.startsWith('And') || line.startsWith('*'))
                .map(line => line.replace(/^\* /, ''));

            return assertions.length > 0 ? assertions : this.convertTestScript(script, variables);

        } catch (error) {
            logger.warn('Copilot conversion failed, using basic conversion', error as Error);
            return this.convertTestScript(script, variables);
        }
    }

    /**
     * Convert pre-request script to Karate using Copilot
     */
    private async convertPreRequestScriptWithCopilot(script: string): Promise<string | null> {
        try {
            const { CopilotService } = await import('./copilotService');

            const prompt = `Convert this Postman pre-request script to Karate DSL.

Postman Pre-Request Script:
\`\`\`javascript
${script}
\`\`\`

Requirements:
1. Convert variable assignments to Karate 'def' statements
2. Convert random data generation to Java interop (java.util.UUID, etc.)
3. Convert date/time operations to Karate equivalents
4. Convert API calls to Karate call statements
5. Use proper Karate syntax for all operations

Return ONLY the Karate code lines (def, call, etc.), one per line.`;

            const models = await import('vscode').then(m => m.default.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' }));
            if (models.length === 0) {
                return this.convertPreRequestScript(script);
            }

            const model = models[0];
            const vscode = await import('vscode');
            const messages = [vscode.default.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {}, new vscode.default.CancellationTokenSource().token);

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            // Parse the response
            const lines = result
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('*') || line.startsWith('def') || line.startsWith('call'))
                .map(line => line.replace(/^\* /, ''));

            return lines.length > 0 ? lines.join('\n') : this.convertPreRequestScript(script);

        } catch (error) {
            logger.warn('Copilot pre-request conversion failed, using basic conversion', error as Error);
            return this.convertPreRequestScript(script);
        }
    }

    /**
     * Convert JSON assertion from Postman to Karate
     */
    private convertJsonAssertion(line: string): string | null {
        // pm.expect(jsonData.id).to.eql(1)
        const eqlMatch = line.match(/jsonData\.([^\)]+)\)\.to\.eql\(([^\)]+)\)/);
        if (eqlMatch) {
            return `And match response.${eqlMatch[1]} == ${eqlMatch[2]}`;
        }

        // pm.expect(jsonData.name).to.be.a('string')
        const typeMatch = line.match(/jsonData\.([^\)]+)\)\.to\.be\.a\(['"]([^'"]+)['"]\)/);
        if (typeMatch) {
            const karateType = typeMatch[2] === 'string' ? '#string' :
                typeMatch[2] === 'number' ? '#number' : '#present';
            return `And match response.${typeMatch[1]} == '${karateType}'`;
        }

        return null;
    }

    /**
     * Convert pre-request script to Karate
     */
    private convertPreRequestScript(script: string): string | null {
        const lines = script.split('\n');
        const karateLines: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();

            // Set variable: pm.environment.set("key", "value")
            if (trimmed.includes('pm.environment.set') || trimmed.includes('pm.variables.set')) {
                const match = trimmed.match(/set\(['"]([^'"]+)['"],\s*['"]?([^'"]+)['"]?\)/);
                if (match) {
                    karateLines.push(`* def ${match[1]} = '${match[2]}'`);
                }
            }

            // Generate random data
            else if (trimmed.includes('$randomInt') || trimmed.includes('$guid')) {
                karateLines.push(`* def randomId = java.util.UUID.randomUUID()`);
            }
        }

        return karateLines.length > 0 ? karateLines.join('\n') : null;
    }

    /**
     * Create Karate feature file from multiple scenarios
     */
    public createFeatureFile(
        featureName: string,
        scenarios: string[],
        variables: Map<string, string>
    ): string {
        const lines: string[] = [];

        lines.push(`Feature: ${featureName}`);
        lines.push('');

        // Add background with variables
        if (variables.size > 0) {
            lines.push('  Background:');
            for (const [key, value] of variables) {
                lines.push(`    * def ${key} = '${value}'`);
            }
            lines.push('');
        }

        // Add scenarios
        lines.push(...scenarios);

        return lines.join('\n');
    }
}
