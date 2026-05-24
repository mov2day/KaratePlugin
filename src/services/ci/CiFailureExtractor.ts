import * as zlib from 'zlib';
import { CIFailurePayload } from './CIFailureIngestor';
import { WorkflowRunJob, WorkflowRunSummary } from './GitHubActionsClient';
import { logger } from '../../utils/logger';

export interface DownloadedArtifact {
    name: string;
    archive: Buffer;
}

export interface CiFailureExtractionInput {
    run: WorkflowRunSummary;
    jobs: WorkflowRunJob[];
    artifacts: DownloadedArtifact[];
    logsArchive?: Buffer;
    artifactNamePattern: string;
}

interface ZipTextEntry {
    name: string;
    text: string;
}

/**
 * Extracts a best-effort CIFailurePayload from GitHub Actions jobs, artifacts, and logs.
 */
export class CiFailureExtractor {
    extract(input: CiFailureExtractionInput): CIFailurePayload | null {
        const failedJob = input.jobs.find(j => j.conclusion === 'failure') || input.jobs[0];
        const failedStep = failedJob?.steps?.find(s => s.conclusion === 'failure')?.name
            || failedJob?.name
            || 'Unknown failed step';

        const candidateTexts = this.collectCandidateTexts(input);
        const featurePath = this.extractFeaturePath(candidateTexts);
        const scenarioName = this.extractScenarioName(candidateTexts)
            || input.run.display_title
            || input.run.name
            || 'Unknown scenario';
        const errorMessage = this.extractErrorMessage(candidateTexts)
            || `GitHub Actions run ${input.run.id} failed`;

        if (!featurePath) {
            logger.warn(`CiFailureExtractor: unable to infer feature path for run ${input.run.id}`);
            return null;
        }

        const httpRequest = this.extractHttpRequest(candidateTexts);
        const httpResponse = this.extractHttpResponse(candidateTexts);

        return {
            source: 'github-actions',
            featurePath,
            scenarioName,
            failedStep,
            errorMessage,
            httpRequest: httpRequest || undefined,
            httpResponse: httpResponse || undefined,
            timestamp: Date.now(),
            runId: `${input.run.id}:${input.run.run_attempt || 1}`
        };
    }

    private collectCandidateTexts(input: CiFailureExtractionInput): string[] {
        const texts: string[] = [];
        const artifactRegex = this.compileArtifactPattern(input.artifactNamePattern);

        for (const artifact of input.artifacts) {
            if (!artifactRegex.test(artifact.name)) {
                continue;
            }
            const entries = this.extractTextEntriesFromZip(artifact.archive);
            for (const entry of entries) {
                texts.push(entry.text);
            }
        }

        if (input.logsArchive) {
            const entries = this.extractTextEntriesFromZip(input.logsArchive);
            for (const entry of entries) {
                texts.push(entry.text);
            }
        }

        return texts;
    }

    private compileArtifactPattern(pattern: string): RegExp {
        try {
            return new RegExp(pattern, 'i');
        } catch {
            return /karate|junit|test|report/i;
        }
    }

    private extractFeaturePath(texts: string[]): string | null {
        const featureRegex = /([A-Za-z0-9_\-./\\]+\.feature)(?::\d+)?/;
        for (const text of texts) {
            const match = text.match(featureRegex);
            if (!match) {
                continue;
            }
            const candidate = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
            if (candidate.startsWith('/')) {
                return candidate.slice(1);
            }
            return candidate;
        }
        return null;
    }

    private extractScenarioName(texts: string[]): string | null {
        const scenarioRegex = /Scenario(?:\s+Outline)?\s*:\s*(.+)/i;
        for (const text of texts) {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                const match = line.match(scenarioRegex);
                if (match && match[1]) {
                    return match[1].trim();
                }
            }
        }
        return null;
    }

    private extractErrorMessage(texts: string[]): string | null {
        const errorLineRegexes = [
            /status code was:\s*\d+,\s*expected:\s*\d+/i,
            /assertion(?:\s+failed)?[:\s].+/i,
            /java\.lang\.[A-Za-z0-9.]+:.+/,
            /error[:\s].+/i,
            /expected.+but.+/i
        ];

        for (const text of texts) {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                if (errorLineRegexes.some(regex => regex.test(trimmed))) {
                    return trimmed.slice(0, 400);
                }
            }
        }

        return null;
    }

    private extractHttpRequest(texts: string[]): { method: string; url: string; body?: string } | null {
        const requestRegexes = [
            />\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/\S+)/i,
            /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/\S+)/i
        ];

        for (const text of texts) {
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                for (const regex of requestRegexes) {
                    const match = line.match(regex);
                    if (!match) {
                        continue;
                    }
                    const body = this.findLikelyJsonBody(lines, i + 1);
                    return {
                        method: match[1].toUpperCase(),
                        url: match[2],
                        body: body || undefined
                    };
                }
            }
        }

        return null;
    }

    private extractHttpResponse(texts: string[]): { status: number; body?: string; headers?: Record<string, string> } | null {
        const statusRegexes = [
            /response status[:=\s]+(\d{3})/i,
            /status code was:\s*(\d{3})/i,
            /status\s*[:=]\s*(\d{3})/i
        ];

        for (const text of texts) {
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                for (const regex of statusRegexes) {
                    const match = line.match(regex);
                    if (!match) {
                        continue;
                    }
                    const status = Number(match[1]);
                    const body = this.findLikelyJsonBody(lines, i + 1);
                    return {
                        status,
                        body: body || undefined
                    };
                }
            }
        }

        return null;
    }

    private findLikelyJsonBody(lines: string[], startIndex: number): string | null {
        for (let i = startIndex; i < Math.min(lines.length, startIndex + 8); i++) {
            const line = lines[i].trim();
            if (!line) {
                continue;
            }
            if (line.startsWith('{') || line.startsWith('[')) {
                return line.slice(0, 500);
            }
        }
        return null;
    }

    private extractTextEntriesFromZip(zipBuffer: Buffer): ZipTextEntry[] {
        try {
            const entries = this.readCentralDirectoryEntries(zipBuffer);
            const textEntries: ZipTextEntry[] = [];
            let totalBytes = 0;

            for (const entry of entries) {
                if (!this.isTextCandidate(entry.name)) {
                    continue;
                }
                const raw = this.readLocalFileData(zipBuffer, entry.localHeaderOffset, entry.compressionMethod, entry.compressedSize);
                if (!raw) {
                    continue;
                }
                totalBytes += raw.length;
                if (totalBytes > 8 * 1024 * 1024) {
                    break;
                }
                const text = raw.toString('utf-8');
                if (this.looksLikeText(text)) {
                    textEntries.push({
                        name: entry.name,
                        text
                    });
                }
            }

            return textEntries;
        } catch (error) {
            logger.warn('CiFailureExtractor: failed to parse zip archive', error as Error);
            return [];
        }
    }

    private readCentralDirectoryEntries(zipBuffer: Buffer): Array<{
        name: string;
        compressedSize: number;
        compressionMethod: number;
        localHeaderOffset: number;
    }> {
        const eocdOffset = this.findEocdOffset(zipBuffer);
        if (eocdOffset < 0) {
            return [];
        }

        const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
        const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

        const entries: Array<{
            name: string;
            compressedSize: number;
            compressionMethod: number;
            localHeaderOffset: number;
        }> = [];

        let offset = centralDirOffset;
        for (let i = 0; i < totalEntries; i++) {
            if (offset + 46 > zipBuffer.length) {
                break;
            }
            const signature = zipBuffer.readUInt32LE(offset);
            if (signature !== 0x02014b50) {
                break;
            }

            const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
            const compressedSize = zipBuffer.readUInt32LE(offset + 20);
            const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
            const extraLength = zipBuffer.readUInt16LE(offset + 30);
            const commentLength = zipBuffer.readUInt16LE(offset + 32);
            const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
            const nameStart = offset + 46;
            const nameEnd = nameStart + fileNameLength;

            if (nameEnd > zipBuffer.length) {
                break;
            }

            const name = zipBuffer.toString('utf-8', nameStart, nameEnd);
            entries.push({
                name,
                compressedSize,
                compressionMethod,
                localHeaderOffset
            });

            offset = nameEnd + extraLength + commentLength;
        }

        return entries;
    }

    private findEocdOffset(zipBuffer: Buffer): number {
        const minEocdSize = 22;
        const maxComment = 0xffff;
        const start = Math.max(0, zipBuffer.length - minEocdSize - maxComment);

        for (let i = zipBuffer.length - minEocdSize; i >= start; i--) {
            if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
                return i;
            }
        }
        return -1;
    }

    private readLocalFileData(zipBuffer: Buffer, localHeaderOffset: number, compressionMethod: number, compressedSize: number): Buffer | null {
        if (localHeaderOffset + 30 > zipBuffer.length) {
            return null;
        }

        const signature = zipBuffer.readUInt32LE(localHeaderOffset);
        if (signature !== 0x04034b50) {
            return null;
        }

        const fileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
        const extraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
        const dataEnd = dataStart + compressedSize;

        if (dataStart < 0 || dataEnd > zipBuffer.length || dataEnd < dataStart) {
            return null;
        }

        const compressed = zipBuffer.subarray(dataStart, dataEnd);
        if (compressionMethod === 0) {
            return compressed;
        }
        if (compressionMethod === 8) {
            return zlib.inflateRawSync(compressed);
        }
        return null;
    }

    private isTextCandidate(fileName: string): boolean {
        const lower = fileName.toLowerCase();
        if (lower.endsWith('/')) {
            return false;
        }
        return /\.(txt|log|json|xml|feature|md|csv)$/i.test(lower)
            || lower.includes('karate')
            || lower.includes('junit')
            || lower.includes('report');
    }

    private looksLikeText(text: string): boolean {
        if (!text) {
            return false;
        }
        const sample = text.slice(0, 2000);
        let printable = 0;
        for (let i = 0; i < sample.length; i++) {
            const code = sample.charCodeAt(i);
            if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
                printable++;
            }
        }
        return printable / sample.length > 0.7;
    }
}
