import * as path from 'path';

export interface KarateV2MigrationResult {
    content: string;
    changes: string[];
    warnings: string[];
}

export class KarateV2Migrator {
    static migrate(content: string, filePath = 'feature.feature'): KarateV2MigrationResult {
        const changes: string[] = [];
        const warnings: string[] = [];
        const lockName = this.lockName(content, filePath);
        let migrated = content;

        migrated = migrated.replace(/@parallel\s*=\s*false\b/g, () => {
            if (!changes.includes('@parallel=false -> @lock')) {
                changes.push('@parallel=false -> @lock');
            }
            return `@lock=${lockName}`;
        });

        const withoutCallerScope = migrated
            .replace(/,\s*scope\s*:\s*['"]caller['"]/g, '')
            .replace(/scope\s*:\s*['"]caller['"]\s*,\s*/g, '')
            .replace(/scope\s*:\s*['"]caller['"]\s*/g, '');
        if (withoutCallerScope !== migrated) {
            changes.push("removed driver scope: 'caller'");
            migrated = withoutCallerScope;
        }

        if (/\bdelay\s*\(/.test(migrated)) {
            warnings.push('delay() before driver init may need karate.pause() in Karate v2');
        }

        return { content: migrated, changes, warnings };
    }

    private static lockName(content: string, filePath: string): string {
        const feature = content.match(/^\s*Feature:\s*(.+)$/m)?.[1] || path.basename(filePath, path.extname(filePath));
        const slug = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return slug || 'feature';
    }
}
