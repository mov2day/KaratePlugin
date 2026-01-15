import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

export interface ConfluencePage {
    id: string;
    title: string;
    body: {
        storage?: { value: string };
        view?: { value: string };
    };
}

export class ConfluenceClient {
    private axiosInstance: AxiosInstance;
    private baseUrl: string;
    private isCloud: boolean;

    constructor(baseUrl: string, email: string, apiToken: string, authType: 'basic' | 'bearer' = 'basic') {
        // Normalize base URL
        this.baseUrl = this.normalizeBaseUrl(baseUrl);
        this.isCloud = this.detectConfluenceType(this.baseUrl);

        // Determine authorization header based on auth type
        let authHeader: string;
        if (authType === 'bearer') {
            // Bearer token for Data Center/Server PAT
            authHeader = `Bearer ${apiToken}`;
            logger.info('Using Bearer token authentication (PAT for Data Center/Server)');
        } else {
            // Basic auth for Cloud (email:token)
            const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
            authHeader = `Basic ${auth}`;
            logger.info('Using Basic authentication (Cloud)');
        }

        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000 // 30 second timeout
        });

        logger.info(`Confluence client initialized: ${this.isCloud ? 'Cloud' : 'Data Center/Server'} at ${this.baseUrl}`);
    }

    /**
     * Normalize base URL to ensure consistent format
     */
    private normalizeBaseUrl(url: string): string {
        // Remove trailing slashes
        let normalized = url.trim().replace(/\/+$/, '');

        // Ensure https:// prefix
        if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
            normalized = 'https://' + normalized;
        }

        // For cloud, ensure /wiki is present
        if (normalized.includes('.atlassian.net') && !normalized.endsWith('/wiki')) {
            normalized += '/wiki';
        }

        return normalized;
    }

    /**
     * Detect if this is Atlassian Cloud or Data Center/Server
     */
    private detectConfluenceType(url: string): boolean {
        return url.includes('.atlassian.net');
    }

    /**
     * Fetch Confluence page by ID
     */
    async getPageById(pageId: string): Promise<ConfluencePage> {
        try {
            logger.info(`Fetching Confluence page: ${pageId}`);

            const response = await this.axiosInstance.get(
                `/rest/api/content/${pageId}`,
                {
                    params: {
                        expand: 'body.storage,body.view,body.atlas_doc_format'
                    }
                }
            );

            logger.info(`Successfully fetched page: ${response.data.title}`);
            return response.data;
        } catch (error: any) {
            logger.error(`Failed to fetch Confluence page: ${pageId}`, error);

            // Provide specific error messages
            if (error.response) {
                const status = error.response.status;
                if (status === 401 || status === 403) {
                    throw new Error(`Authentication failed. Please check your Confluence email and API token in settings. (Status: ${status})`);
                } else if (status === 404) {
                    throw new Error(`Page ${pageId} not found. Please verify the page ID or URL.`);
                } else {
                    throw new Error(`Failed to fetch Confluence page (Status ${status}): ${error.response.data?.message || error.message}`);
                }
            } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                throw new Error(`Cannot connect to Confluence at ${this.baseUrl}. Please check the base URL in settings.`);
            } else if (error.code === 'ETIMEDOUT') {
                throw new Error(`Connection to Confluence timed out. Please check your network connection.`);
            } else {
                throw new Error(`Failed to fetch Confluence page: ${error.message}`);
            }
        }
    }

    /**
     * Extract page ID from Confluence URL
     */
    static extractPageIdFromUrl(url: string): string | null {
        // Match patterns like:
        // https://yourcompany.atlassian.net/wiki/spaces/SPACE/pages/123456/Page+Title
        // https://yourcompany.atlassian.net/wiki/pages/123456

        const patterns = [
            /\/pages\/(\d+)/,
            /pageId=(\d+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return match[1];
            }
        }

        return null;
    }

    /**
     * Search for pages by title
     */
    async searchPagesByTitle(title: string, spaceKey?: string): Promise<ConfluencePage[]> {
        try {
            logger.info(`Searching for pages with title: ${title}`);

            let cql = `title ~ "${title}"`;
            if (spaceKey) {
                cql += ` and space = ${spaceKey}`;
            }

            const response = await this.axiosInstance.get('/rest/api/content/search', {
                params: {
                    cql,
                    expand: 'body.storage,body.view'
                }
            });

            logger.info(`Found ${response.data.results.length} pages`);
            return response.data.results;
        } catch (error: any) {
            logger.error('Failed to search Confluence pages', error);
            throw new Error(`Failed to search Confluence pages: ${error.message}`);
        }
    }
}
