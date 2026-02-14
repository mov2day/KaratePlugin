import { logger } from '../utils/logger';

/**
 * Service to sanitize and validate inputs before sending to AI services.
 * Prevents prompt injection, sensitive data leakage, and ensures data quality.
 */
export class InputSanitizer {

    /**
     * Sanitize OpenAPI specification content
     * Removes scripts, comments, and potential injection vectors
     */
    static sanitizeSpec(content: string): string {
        if (!content) return '';

        let sanitized = content;

        // Remove block comments which might contain instruction overrides
        sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, '');

        // Remove line comments (carefully, as JSON/YAML might use them differently, but for raw text prompt context it's safer to remove)
        // Actually, YAML comments # are valid, JSON doesn't support them. 
        // We'll stick to removing obviously malicious script tags if any (unlikely in valid Spec but possible in description fields)
        sanitized = sanitized.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, '');

        // Remove base64 data URIs to save tokens and prevent large payload injections
        sanitized = sanitized.replace(/data:[^;]+;base64,[a-zA-Z0-9+/=]+/g, '[REDACTED_BASE64_DATA]');

        return sanitized.trim();
    }

    /**
     * Sanitize Confluence page content
     * Strips HTML scripts, styles, and potentially sensitive metadata
     */
    static sanitizeConfluence(content: string): string {
        if (!content) return '';

        let sanitized = content;

        // Remove script tags
        sanitized = sanitized.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, '');

        // Remove style tags
        sanitized = sanitized.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, '');

        // Remove HTML comments
        sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

        // Remove incomplete tags or potential injection attempts
        sanitized = sanitized.replace(/javascript:/gi, 'rejected-script:');
        sanitized = sanitized.replace(/vbscript:/gi, 'rejected-script:');
        sanitized = sanitized.replace(/onload=/gi, 'rejected-attr=');
        sanitized = sanitized.replace(/onerror=/gi, 'rejected-attr=');

        return sanitized.trim();
    }

    /**
     * Sanitize HAR (HTTP Archive) content
     * strict removal of Authorization headers, Cookies, and specific PII patterns
     */
    static sanitizeHar(content: string): string {
        if (!content) return '';

        let sanitized = content;

        // We can't easily parse partial JSON/text with regex, but we can target specific key-value patterns

        // 1. Redact Authorization headers
        // Matches "name": "Authorization", "value": "..."
        sanitized = sanitized.replace(/("name"\s*:\s*"Authorization"\s*,\s*"value"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
        // Matches "Authorization": "..."
        sanitized = sanitized.replace(/("Authorization"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');

        // 2. Redact Cookie headers
        sanitized = sanitized.replace(/("name"\s*:\s*"Cookie"\s*,\s*"value"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
        sanitized = sanitized.replace(/("Cookie"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');

        // 3. Redact common API Key patterns
        sanitized = sanitized.replace(/("x-api-key"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
        sanitized = sanitized.replace(/("apikey"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');

        // 4. Redact potential passwords in bodies
        sanitized = sanitized.replace(/("password"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
        sanitized = sanitized.replace(/("client_secret"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
        sanitized = sanitized.replace(/("access_token"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');

        return sanitized;
    }

    /**
     * Sanitize user instructions/prompt inputs
     * Ensures user isn't accidentally trying to break the system prompt
     */
    static sanitizeUserInstruction(instruction: string): string {
        if (!instruction) return '';

        let sanitized = instruction;

        // Prevent system prompt overrides
        // System prompt often uses "You are a...", "Ignore previous instructions", etc.
        const blockedPhrases = [
            /ignore previous instructions/gi,
            /system prompt/gi,
            /you are now/gi
        ];

        for (const phrase of blockedPhrases) {
            if (sanitized.match(phrase)) {
                logger.warn(`Blocked potential prompt injection phrase: ${phrase}`);
                sanitized = sanitized.replace(phrase, '[BLOCKED_PHRASE]');
            }
        }

        return sanitized.trim();
    }

    /**
     * Generic redactor for logs
     */
    static redact(message: string): string {
        if (!message) return '';

        let redacted = message;
        // Bearer tokens (simple heuristics)
        redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9\-\._~\+\/]+=*/g, '$1[REDACTED]');

        // Basic Email redaction
        redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');

        return redacted;
    }
}
