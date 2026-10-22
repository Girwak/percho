import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ArchiveConfigInfo, ArchivedSessionMeta } from "@percho/shared";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";

const log = createLogger("archive");

export const ARCHIVE_DIR_NAME = "archived-sessions";
export const ARCHIVE_MANIFEST_FILE = "archive-manifest.json";
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 7;
export const ARCHIVE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_DAYS = 3650;

interface ArchiveManifestEntry {
	sessionId: string;
	archivedAt: number;
}

interface ArchiveManifest {
	sessions: Record<string, ArchiveManifestEntry>;
}

function archiveRoot(agentDir: string): string {
	return join(agentDir, ARCHIVE_DIR_NAME);
}

function sessionsRoot(agentDir: string): string {
	return join(agentDir, "sessions");
}

function manifestStore(agentDir: string): JsonStore<ArchiveManifest> {
	return new JsonStore<ArchiveManifest>({
		path: join(archiveRoot(agentDir), ARCHIVE_MANIFEST_FILE),
		defaultValue: () => ({ sessions: {} }),
	});
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function stripJsonC(raw: string): string {
	return raw
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/,\s*([}\]])/g, "$1");
}

function parseSettings(raw: string): Record<string, unknown> | null {
	const candidates = [raw, stripJsonC(raw)];
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {}
	}
	return null;
}

function parseRetentionDays(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= MAX_RETENTION_DAYS) {
		return Math.floor(value);
	}
	return DEFAULT_ARCHIVE_RETENTION_DAYS;
}

export function readArchiveRetentionDays(agentDir: string): number | null {
	const file = join(agentDir, "settings.json");
	try {
		const parsed = parseSettings(readFileSync(file, "utf8"));
		return parseRetentionDays(parsed?.archiveRetentionDays);
	} catch (error) {
		log.warn("archive retention read failed, falling back to default", {
			file,
			error: error instanceof Error ? error.message : String(error),
		});
		return DEFAULT_ARCHIVE_RETENTION_DAYS;
	}
}

export function writeArchiveRetentionDays(agentDir: string, days: number | null): void {
	new JsonStore<Record<string, unknown>>({
		path: join(agentDir, "settings.json"),
		defaultValue: () => ({}),
		parse: (raw) => {
			const parsed = parseSettings(raw);
			if (!parsed) throw new Error("settings.json parse failed (not an object)");
			return parsed;
		},
	}).updateSync((existing) => {
		existing.archiveRetentionDays = days;
	});
}

export function getArchiveConfig(agentDir: string): ArchiveConfigInfo {
	return { retentionDays: readArchiveRetentionDays(agentDir) };
}

export function archiveSessionFile(sessionId: string, sessionFile: string, agentDir: string): string {
	const fromRoot = sessionsRoot(agentDir);
	const projectDir = dirname(sessionFile);
	if (!isInside(fromRoot, projectDir)) {
		throw new Error(`Session file is not in the sessions tree: ${sessionFile}`);
	}
	if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
	const destDir = join(archiveRoot(agentDir), basename(projectDir));
	const dest = join(destDir, basename(sessionFile));
	if (existsSync(dest)) throw new Error(`Archived session already exists: ${dest}`);
	mkdirSync(destDir, { recursive: true });
	renameSync(sessionFile, dest);
	manifestStore(agentDir).updateSync((manifest) => {
		manifest.sessions[dest] = { sessionId, archivedAt: Date.now() };
	});
	log.info("session archived", sessionId, { from: sessionFile, to: dest });
	return dest;
}

export function unarchiveSessionFile(archivedFile: string, agentDir: string): string {
	const fromRoot = archiveRoot(agentDir);
	const projectDir = dirname(archivedFile);
	if (!isInside(fromRoot, projectDir)) {
		throw new Error(`Archived session file is not in the archive tree: ${archivedFile}`);
	}
	if (!existsSync(archivedFile)) throw new Error(`Archived session not found: ${archivedFile}`);
	const destDir = join(sessionsRoot(agentDir), basename(projectDir));
	const dest = join(destDir, basename(archivedFile));
	if (existsSync(dest)) throw new Error(`Session already exists in history: ${dest}`);
	mkdirSync(destDir, { recursive: true });
	renameSync(archivedFile, dest);
	manifestStore(agentDir).updateSync((manifest) => {
		delete manifest.sessions[archivedFile];
	});
	try {
		rmdirSync(projectDir);
	} catch {}
	log.info("session unarchived", { from: archivedFile, to: dest });
	return dest;
}

export function deleteArchivedSessionFile(archivedFile: string, agentDir: string): void {
	const fromRoot = archiveRoot(agentDir);
	if (!isInside(fromRoot, dirname(archivedFile))) {
		throw new Error(`Archived session file is not in the archive tree: ${archivedFile}`);
	}
	rmSync(archivedFile, { force: true });
	manifestStore(agentDir).updateSync((manifest) => {
		delete manifest.sessions[archivedFile];
	});
	try {
		rmdirSync(dirname(archivedFile));
	} catch {}
}

export async function readArchivedSessions(
	agentDir: string,
	retentionDays: number | null,
): Promise<ArchivedSessionMeta[]> {
	const root = archiveRoot(agentDir);
	if (!existsSync(root)) return [];
	const manifest = manifestStore(agentDir).readSync().sessions;
	let dirs: string[] = [];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => join(root, entry.name));
	} catch (error) {
		log.warn("archive root scan failed", { root, error: String(error) });
		return [];
	}
	const all: ArchivedSessionMeta[] = [];
	for (const dir of dirs) {
		let infos: SessionInfo[];
		try {
			infos = await SessionManager.listAll(dir);
		} catch (error) {
			log.warn("archived project dir scan failed", dir, error);
			continue;
		}
		for (const info of infos) {
			if (!info.cwd) continue;
			let archivedAt = manifest[info.path]?.archivedAt;
			if (archivedAt === undefined) {
				try {
					archivedAt = statSync(info.path).mtimeMs;
				} catch {
					continue;
				}
			}
			all.push({
				sessionId: info.id,
				sessionFile: info.path,
				cwd: info.cwd,
				name: info.name,
				messageCount: info.messageCount,
				createdAt: info.created.getTime(),
				modifiedAt: info.modified.getTime(),
				archivedAt,
				expiresAt: retentionDays === null ? null : archivedAt + retentionDays * DAY_MS,
			});
		}
	}
	return all.sort((a, b) => b.archivedAt - a.archivedAt);
}

export async function purgeExpiredArchives(
	agentDir: string,
	retentionDays: number | null,
	now = Date.now(),
): Promise<number> {
	if (retentionDays === null) return 0;
	const cutoff = now - retentionDays * DAY_MS;
	const metas = await readArchivedSessions(agentDir, retentionDays);
	let purged = 0;
	for (const meta of metas) {
		if (meta.archivedAt > cutoff) continue;
		try {
			rmSync(meta.sessionFile, { force: true });
			manifestStore(agentDir).updateSync((manifest) => {
				delete manifest.sessions[meta.sessionFile];
			});
			try {
				rmdirSync(dirname(meta.sessionFile));
			} catch {}
			purged += 1;
		} catch (error) {
			log.warn("expired archive removal failed", meta.sessionFile, error);
		}
	}
	if (purged > 0) log.info("expired archives purged", purged);
	return purged;
}

export function reconcileArchiveManifest(agentDir: string): void {
	const store = manifestStore(agentDir);
	const manifest = store.readSync().sessions;
	const dead = Object.keys(manifest).filter((path) => !existsSync(path));
	if (dead.length === 0) return;
	store.updateSync((draft) => {
		for (const path of dead) delete draft.sessions[path];
	});
	log.info("archive manifest reconciled", dead.length);
}
