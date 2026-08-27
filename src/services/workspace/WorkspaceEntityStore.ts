import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const WORKSPACE_SCHEMA_VERSION = 2;

export type WorkspaceEntityKind =
    | 'run-profiles'
    | 'environments'
    | 'traceability'
    | 'findings'
    | 'actions'
    | 'runs';

export interface WorkspaceEntity {
    id: string;
    createdAt: number;
    updatedAt: number;
    [key: string]: unknown;
}

interface WorkspaceManifest {
    schemaVersion: number;
    createdAt: number;
    updatedAt: number;
}

interface MigrationJournal {
    source: string;
    completedAt: number;
    migratedRunIds: string[];
    corruptedFiles: string[];
}

interface MigratedRun extends WorkspaceEntity {
    legacyFile?: string;
}

const ENTITY_KINDS: WorkspaceEntityKind[] = [
    'run-profiles', 'environments', 'traceability', 'findings', 'actions', 'runs'
];

/**
 * Git-friendly workspace persistence. Each mutable record owns a UUID file so
 * independent changes merge without a shared JSON document becoming a conflict hotspot.
 */
export class WorkspaceEntityStore {
    static readonly DIRECTORY = '.karate-test-management';
    private static readonly MANIFEST_FILE = 'manifest.json';
    private static readonly LOCK_DIRECTORY = 'locks';
    private static readonly MIGRATION_DIRECTORY = 'migration';
    private static readonly BACKUP_DIRECTORY = 'backups';

    constructor(private readonly workspaceRoot: string) { }

    get rootPath(): string {
        return path.join(this.workspaceRoot, WorkspaceEntityStore.DIRECTORY);
    }

    initialize(): void {
        fs.mkdirSync(this.rootPath, { recursive: true });
        for (const kind of ENTITY_KINDS) {
            fs.mkdirSync(this.entityDirectory(kind), { recursive: true });
        }
        fs.mkdirSync(this.lockDirectory(), { recursive: true });
        fs.mkdirSync(this.migrationDirectory(), { recursive: true });
        fs.mkdirSync(this.backupDirectory(), { recursive: true });

        const ignorePath = path.join(this.rootPath, '.gitignore');
        if (!fs.existsSync(ignorePath)) {
            this.writeAtomic(ignorePath, 'locks/\nmigration/\nbackups/\n');
        }

        const manifestPath = path.join(this.rootPath, WorkspaceEntityStore.MANIFEST_FILE);
        if (!fs.existsSync(manifestPath)) {
            const now = Date.now();
            this.writeAtomic(manifestPath, JSON.stringify({
                schemaVersion: WORKSPACE_SCHEMA_VERSION,
                createdAt: now,
                updatedAt: now
            } satisfies WorkspaceManifest, null, 2));
        }
    }

    list<T>(kind: WorkspaceEntityKind): T[] {
        this.initialize();
        return fs.readdirSync(this.entityDirectory(kind))
            .filter(file => file.endsWith('.json'))
            .sort()
            .flatMap(file => {
                try {
                    return [JSON.parse(fs.readFileSync(path.join(this.entityDirectory(kind), file), 'utf8')) as T];
                } catch {
                    return [];
                }
            });
    }

    get<T>(kind: WorkspaceEntityKind, id: string): T | undefined {
        this.initialize();
        const filePath = this.entityPath(kind, id);
        if (!fs.existsSync(filePath)) return undefined;
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }

    save<T extends object>(kind: WorkspaceEntityKind, entity: T, id?: string): WorkspaceEntity & T {
        this.initialize();
        return this.withLock(() => {
            const entityId = id || this.createId(kind);
            const existing = this.get<WorkspaceEntity>(kind, entityId);
            const now = Date.now();
            const next = {
                ...entity,
                id: entityId,
                createdAt: existing?.createdAt || now,
                updatedAt: now
            } as WorkspaceEntity & T;
            this.writeAtomic(this.entityPath(kind, entityId), JSON.stringify(next, null, 2));
            this.touchManifest();
            return next;
        });
    }

    remove(kind: WorkspaceEntityKind, id: string): void {
        this.initialize();
        this.withLock(() => {
            const filePath = this.entityPath(kind, id);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            this.touchManifest();
        });
    }

    /** Migrates legacy run files without changing or deleting their original directory. */
    migrateLegacyHistory(onProgress?: (current: number, total: number) => void): { migrated: number; corrupted: string[] } {
        this.initialize();
        const legacyDirectory = path.join(this.workspaceRoot, '.karate-test-history');
        if (!fs.existsSync(legacyDirectory)) return { migrated: 0, corrupted: [] };

        return this.withLock(() => {
            const journalPath = path.join(this.migrationDirectory(), 'history-v1.json');
            if (fs.existsSync(journalPath)) {
                const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
                return { migrated: journal.migratedRunIds.length, corrupted: journal.corruptedFiles };
            }

            const backupTarget = path.join(this.backupDirectory(), 'history-v1');
            if (!fs.existsSync(backupTarget)) this.copyDirectory(legacyDirectory, backupTarget);

            const files = fs.readdirSync(legacyDirectory).filter(file => file.endsWith('.json')).sort();
            // A journal is intentionally ignored by Git and can be lost when a workspace is
            // copied or a migration is interrupted. The per-record source marker is the
            // durable idempotency key in that situation.
            const previouslyMigrated = new Set(this.list<MigratedRun>('runs')
                .map(run => run.legacyFile)
                .filter((file): file is string => Boolean(file)));
            const corruptedFiles: string[] = [];
            files.forEach((file, index) => {
                onProgress?.(index + 1, files.length);
                if (previouslyMigrated.has(file)) return;
                try {
                    const value = JSON.parse(fs.readFileSync(path.join(legacyDirectory, file), 'utf8')) as Record<string, unknown>;
                    const legacyId = typeof value.id === 'string' && value.id ? value.id : undefined;
                    const preferredId = legacyId && isUuid(legacyId) ? legacyId : undefined;
                    const id = preferredId && !fs.existsSync(this.entityPath('runs', preferredId)) ? preferredId : this.createId('runs');
                    const now = Date.now();
                    const migratedEntity: WorkspaceEntity = {
                        ...value,
                        id,
                        createdAt: typeof value.timestamp === 'number' ? value.timestamp : now,
                        updatedAt: now,
                        migratedFrom: '.karate-test-history',
                        legacyFile: file,
                        legacyId
                    };
                    this.writeAtomic(this.entityPath('runs', id), JSON.stringify(migratedEntity, null, 2));
                    this.touchManifest();
                } catch {
                    corruptedFiles.push(file);
                }
            });
            const allMigratedRunIds = this.list<MigratedRun>('runs')
                .filter(run => run.migratedFrom === '.karate-test-history')
                .map(run => run.id);
            this.writeAtomic(journalPath, JSON.stringify({
                source: '.karate-test-history', completedAt: Date.now(), migratedRunIds: allMigratedRunIds, corruptedFiles
            } satisfies MigrationJournal, null, 2));
            return { migrated: allMigratedRunIds.length, corrupted: corruptedFiles };
        });
    }

    private entityDirectory(kind: WorkspaceEntityKind): string {
        return path.join(this.rootPath, kind);
    }

    private entityPath(kind: WorkspaceEntityKind, id: string): string {
        if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Workspace entity id is invalid');
        return path.join(this.entityDirectory(kind), `${id}.json`);
    }

    private createId(kind: WorkspaceEntityKind): string {
        for (let attempt = 0; attempt < 5; attempt++) {
            const id = randomUUID();
            if (!fs.existsSync(this.entityPath(kind, id))) return id;
        }
        throw new Error(`Could not allocate a unique ${kind} entity id`);
    }

    private lockDirectory(): string { return path.join(this.rootPath, WorkspaceEntityStore.LOCK_DIRECTORY); }
    private migrationDirectory(): string { return path.join(this.rootPath, WorkspaceEntityStore.MIGRATION_DIRECTORY); }
    private backupDirectory(): string { return path.join(this.rootPath, WorkspaceEntityStore.BACKUP_DIRECTORY); }

    private withLock<T>(operation: () => T): T {
        const lockPath = path.join(this.lockDirectory(), 'workspace.lock');
        let descriptor: number | undefined;
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                descriptor = fs.openSync(lockPath, 'wx');
                break;
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                // A process crash cannot execute finally. Treat a sufficiently old lock as
                // abandoned so an interrupted migration can recover on the next activation.
                try {
                    if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
                        fs.unlinkSync(lockPath);
                        continue;
                    }
                } catch (lockError: unknown) {
                    if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError;
                    continue;
                }
                // Do not spin on the extension host's single JavaScript thread. A later
                // action can retry safely, while a stale lock is recovered above.
                break;
            }
        }
        if (descriptor === undefined) throw new Error('Workspace state is busy; retry the operation.');
        try {
            return operation();
        } finally {
            fs.closeSync(descriptor);
            if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        }
    }

    private touchManifest(): void {
        const manifestPath = path.join(this.rootPath, WorkspaceEntityStore.MANIFEST_FILE);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as WorkspaceManifest;
        this.writeAtomic(manifestPath, JSON.stringify({ ...manifest, schemaVersion: WORKSPACE_SCHEMA_VERSION, updatedAt: Date.now() }, null, 2));
    }

    private writeAtomic(target: string, content: string): void {
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, content, 'utf8');
        fs.renameSync(temporary, target);
    }

    private copyDirectory(source: string, destination: string): void {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            const from = path.join(source, entry.name);
            const to = path.join(destination, entry.name);
            if (entry.isDirectory()) this.copyDirectory(from, to);
            else fs.copyFileSync(from, to);
        }
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
