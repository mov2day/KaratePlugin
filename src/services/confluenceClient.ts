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

    constructor(baseUrl: string, email: string, apiToken: string) {
        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

        this.axiosInstance = axios.create({
            baseURL: baseUrl,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
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
                        expand: 'body.storage,body.view'
                    }
                }
            );

            logger.info(`Successfully fetched page: ${response.data.title}`);
            return response.data;
        } catch (error: any) {
            logger.error(`Failed to fetch Confluence page: ${pageId}`, error);
            throw new Error(`Failed to fetch Confluence page: ${error.message}`);
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
