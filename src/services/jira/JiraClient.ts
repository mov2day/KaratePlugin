import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger';

/**
 * Jira issue structure.
 */
export interface JiraIssue {
    key: string;
    fields: {
        summary: string;
        description: any;  // ADF format
        issuetype: { name: string };
        status: { name: string };
        labels: string[];
        priority?: { name: string };
        [key: string]: any;
    };
}

/**
 * JiraClient — HTTP client for Jira REST API v3.
 * Supports Cloud (Basic auth) and Data Center (PAT bearer).
 * Mirrors ConfluenceClient.ts pattern.
 */
export class JiraClient {
    private axiosInstance: AxiosInstance;
    private baseUrl: string;

    constructor(baseUrl: string, email: string, apiToken: string, authType: 'basic' | 'bearer' = 'basic') {
        this.baseUrl = baseUrl.replace(/\/+$/, '');

        let authHeader: string;
        if (authType === 'bearer') {
            authHeader = `Bearer ${apiToken}`;
            logger.info('JiraClient: using Bearer auth (PAT)');
        } else {
            const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
            authHeader = `Basic ${auth}`;
            logger.info('JiraClient: using Basic auth (Cloud)');
        }

        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
    }

    /**
     * Fetch a single Jira issue by key (e.g., PROJ-1234).
     */
    async getIssue(issueKey: string): Promise<JiraIssue> {
        try {
            logger.info(`JiraClient: fetching issue ${issueKey}`);
            const response = await this.axiosInstance.get(
                `/rest/api/3/issue/${issueKey}`,
                { params: { fields: 'summary,description,issuetype,status,labels,priority,acceptance_criteria' } }
            );
            return response.data;
        } catch (error: any) {
            if (error.response?.status === 401 || error.response?.status === 403) {
                throw new Error('Jira authentication failed. Check credentials in settings.');
            }
            if (error.response?.status === 404) {
                throw new Error(`Jira issue ${issueKey} not found.`);
            }
            throw new Error(`Failed to fetch Jira issue: ${error.message}`);
        }
    }

    /**
     * Search issues using JQL.
     */
    async searchJQL(jql: string, maxResults: number = 10): Promise<JiraIssue[]> {
        try {
            logger.info(`JiraClient: searching JQL: ${jql}`);
            const response = await this.axiosInstance.post('/rest/api/3/search', {
                jql,
                maxResults,
                fields: ['summary', 'description', 'issuetype', 'status', 'labels', 'priority']
            });
            return response.data.issues || [];
        } catch (error: any) {
            if (error.response?.status === 400) {
                throw new Error('Invalid JQL query. Please check your syntax.');
            }
            throw new Error(`Jira search failed: ${error.message}`);
        }
    }
}
