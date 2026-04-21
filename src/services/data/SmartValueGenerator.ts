import { logger } from '../../utils/logger';

/**
 * SmartValueGenerator — field-name-aware, format-aware test value generation.
 * Replaces generic placeholders with realistic values.
 */
export class SmartValueGenerator {

    /**
     * Generate a realistic value for a given field based on name, format, and schema.
     */
    static generate(fieldName: string, schema: any): any {
        if (!schema) {
            return null;
        }

        // Honour explicit examples and defaults first
        if (schema.example !== undefined) {
            return schema.example;
        }
        if (schema.default !== undefined) {
            return schema.default;
        }

        // Enum — return first value
        if (schema.enum && schema.enum.length > 0) {
            return schema.enum[0];
        }

        const name = (fieldName || '').toLowerCase();
        const format = (schema.format || '').toLowerCase();
        const type = (schema.type || '').toLowerCase();

        // Name-based heuristics
        const value = this.matchByFieldName(name, format, type, schema);
        if (value !== undefined) {
            return value;
        }

        // Format-based fallback
        const formatValue = this.matchByFormat(format, type, schema);
        if (formatValue !== undefined) {
            return formatValue;
        }

        // Type-based fallback
        return this.matchByType(type, schema, fieldName);
    }

    private static matchByFieldName(name: string, format: string, type: string, schema: any): any {
        // Email patterns
        if (name === 'email' || name === 'emailaddress' || name.endsWith('email')) {
            return 'test.user@example.com';
        }

        // Phone patterns
        if (name === 'phone' || name === 'phonenumber' || name.endsWith('phone')) {
            return '+1-555-000-1234';
        }

        // UUID / ID patterns
        if (format === 'uuid' || name.endsWith('id') || name.endsWith('_id')) {
            return 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        }

        // Date/time patterns
        if (name.includes('createdat') || name.includes('updatedat') || name.endsWith('date') || name.endsWith('time') || name.includes('timestamp')) {
            return '2025-01-15T09:30:00Z';
        }

        // Name patterns
        if (name === 'name' || name === 'fullname') {
            return 'Jane Smith';
        }
        if (name === 'firstname' || name === 'first_name') {
            return 'Jane';
        }
        if (name === 'lastname' || name === 'last_name') {
            return 'Smith';
        }

        // Username
        if (name === 'username' || name === 'user_name') {
            return 'janesmith';
        }

        // Password
        if (name === 'password') {
            return 'P@ssw0rd123!';
        }

        // URL patterns
        if (name === 'url' || name === 'website' || name.endsWith('url')) {
            return 'https://example.com';
        }

        // Address
        if (name === 'address' || name === 'street') {
            return '123 Main Street';
        }
        if (name === 'city') {
            return 'New York';
        }
        if (name === 'country') {
            return 'US';
        }
        if (name === 'zipcode' || name === 'zip' || name === 'postalcode' || name === 'postal_code') {
            return '10001';
        }

        // Amount / price patterns
        if (name === 'amount' || name === 'price' || name === 'total' || name === 'cost') {
            return this.numericWithConstraints(schema, 99.99);
        }

        // Age / count
        if (name === 'age') {
            return this.numericWithConstraints(schema, 30);
        }
        if (name === 'count' || name === 'quantity' || name === 'qty') {
            return this.numericWithConstraints(schema, 5);
        }

        // Status / state (without enum — return generic)
        if (name === 'status' || name === 'state') {
            return 'active';
        }

        // Description / notes
        if (name === 'description' || name === 'notes' || name === 'comment') {
            return 'Sample description text';
        }

        // Title / subject
        if (name === 'title' || name === 'subject') {
            return 'Sample Title';
        }

        return undefined;
    }

    private static matchByFormat(format: string, type: string, schema: any): any {
        switch (format) {
            case 'email':
                return 'test.user@example.com';
            case 'uuid':
                return 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
            case 'date':
                return '2025-01-15';
            case 'date-time':
                return '2025-01-15T09:30:00Z';
            case 'uri':
            case 'url':
                return 'https://example.com';
            case 'ipv4':
                return '192.168.1.1';
            case 'ipv6':
                return '::1';
            case 'hostname':
                return 'example.com';
            case 'int32':
            case 'int64':
                return this.numericWithConstraints(schema, 123);
            case 'float':
            case 'double':
                return this.numericWithConstraints(schema, 99.99);
            case 'binary':
                return 'dGVzdA==';
            case 'byte':
                return 'dGVzdA==';
            case 'password':
                return 'P@ssw0rd123!';
        }
        return undefined;
    }

    private static matchByType(type: string, schema: any, fieldName: string): any {
        switch (type) {
            case 'string':
                return 'string';
            case 'number':
            case 'integer':
                return this.numericWithConstraints(schema, 123);
            case 'boolean':
                return true;
            case 'array':
                if (schema.items) {
                    return [SmartValueGenerator.generate(fieldName, schema.items)];
                }
                return [];
            case 'object':
                if (schema.properties) {
                    const obj: Record<string, any> = {};
                    for (const [key, propSchema] of Object.entries(schema.properties)) {
                        obj[key] = SmartValueGenerator.generate(key, propSchema);
                    }
                    return obj;
                }
                return {};
            default:
                return null;
        }
    }

    /**
     * Generate numeric value respecting minimum/maximum constraints
     */
    private static numericWithConstraints(schema: any, defaultValue: number): number {
        let value = defaultValue;

        if (schema?.minimum !== undefined && value < schema.minimum) {
            value = schema.minimum;
        }
        if (schema?.maximum !== undefined && value > schema.maximum) {
            value = schema.maximum;
        }
        if (schema?.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
            value = schema.exclusiveMinimum + 1;
        }
        if (schema?.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
            value = schema.exclusiveMaximum - 1;
        }

        return value;
    }
}
