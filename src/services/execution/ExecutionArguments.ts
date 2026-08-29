import * as path from 'path';
import { TestExecutionOptions } from '../../types';

export function scenarioLineFromEditorLine(zeroBasedLine: number): number {
    if (!Number.isInteger(zeroBasedLine) || zeroBasedLine < 0) throw new Error('Scenario editor line must be a non-negative integer.');
    return zeroBasedLine + 1;
}

function scenarioTarget(options: TestExecutionOptions, target: string): string {
    if (options.scenarioLine && options.scenarioLine > 0) return `${target}:${options.scenarioLine}`;
    const legacy = target.match(/^(.*\.feature):(\d+)$/i);
    if (legacy) return `${legacy[1]}:${legacy[2]}`;
    throw new Error('Scenario execution requires an exact one-based scenario line.');
}

/** Build the common Karate option grammar used by CLI and karate.options. */
export function buildKarateArguments(options: TestExecutionOptions, configDir?: string): string[] {
    const args: string[] = [];
    if (options.tags?.length) args.push('--tags', options.tags.map(tag => `@${tag.replace(/^@/, '')}`).join(','));
    if (options.parallel && options.parallel > 1) args.push('--threads', String(options.parallel));
    if (configDir) args.push('--configdir', configDir);

    const targets = Array.isArray(options.target) ? options.target : [options.target];
    if (options.type === 'scenario') {
        if (targets.length !== 1) throw new Error('Scenario execution accepts exactly one feature target.');
        args.push(scenarioTarget(options, targets[0]));
    } else {
        args.push(...targets.filter(Boolean));
    }
    return args;
}

export function serializeKarateOptions(args: string[]): string {
    return args.map(value => {
        if (!/[\s"\\]/.test(value)) return value;
        return `"${value.replace(/(["\\])/g, '\\$1')}"`;
    }).join(' ');
}

export function normalizedFeaturePath(options: TestExecutionOptions): string | undefined {
    if (Array.isArray(options.target) || !['feature', 'scenario'].includes(options.type)) return undefined;
    return path.resolve(options.target.replace(/:(\d+)$/, ''));
}
