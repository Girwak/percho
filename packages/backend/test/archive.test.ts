import { copyFileSync, existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonStore } from "../src/json-store";
import { PiBackend } from "../src/pi-backend";
import {
	ARCHIVE_DIR_NAME,
	ARCHIVE_MANIFEST_FILE,
	archiveSessionFile,
	deleteArchivedSessionFile,
	purgeExpiredArchives,
	readArchivedSessions,
	readArchiveRetentionDays,
	reconcileArchiveManifest,
	unarchiveSessionFile,
	writeArchiveRetentionDays,
} from "../src/session/archive";

let testRoot = "";

beforeAll(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "session-archive-"));
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

function makeSession(agentDir: string, projDirName: string, text: string): string {
	const dir = join(agentDir, "sessions", projDirName);
	const sm = SessionManager.create("/tmp/project", dir);
	sm.appendMessage({ role: "user", content: text, timestamp: Date.now() } satisfies Message);
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "reply" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude",
		timestamp: Date.now(),
	} as unknown as Message);
	return sm.getSessionFile() ?? "";
}

type Manifest = { sessions: Record<string, { sessionId: string; archivedAt: number }> };

function manifestStore(agentDir: string): JsonStore<Manifest> {
	return new JsonStore<Manifest>({
		path: join(agentDir, ARCHIVE_DIR_NAME, ARCHIVE_MANIFEST_FILE),
		defaultValue: () => ({ sessions: {} }),
	});
}

describe("archiveSessionFile / unarchiveSessionFile", () => {
	it("moves the session file into the archive tree and records the manifest", () => {
		const file = makeSession(testRoot, "proj-a", "hello archive");
		const dest = archiveSessionFile("sid-1", file, testRoot);
		expect(existsSync(file)).toBe(false);
		expect(dest).toContain(ARCHIVE_DIR_NAME);
		expect(existsSync(dest)).toBe(true);
		const manifest = manifestStore(testRoot).readSync();
		expect(manifest.sessions[dest]).toMatchObject({ sessionId: "sid-1" });
	});

	it("rejects files outside the sessions tree", () => {
		const outside = makeSession(testRoot, "proj-b", "not under sessions");
		const moved = join(testRoot, ARCHIVE_DIR_NAME, "proj-b", "x.jsonl");
		expect(() => archiveSessionFile("sid-2", moved, testRoot)).toThrow();
		expect(existsSync(outside)).toBe(true);
	});

	it("round-trips back into the sessions tree and clears the manifest entry", () => {
		const file = makeSession(testRoot, "proj-c", "round trip");
		const dest = archiveSessionFile("sid-3", file, testRoot);
		const restored = unarchiveSessionFile(dest, testRoot);
		expect(restored).toBe(file);
		expect(existsSync(file)).toBe(true);
		expect(manifestStore(testRoot).readSync().sessions[dest]).toBeUndefined();
	});

	it("refuses to overwrite an existing archived file", () => {
		const file = makeSession(testRoot, "proj-d", "dupe");
		const dest = archiveSessionFile("sid-4", file, testRoot);
		copyFileSync(dest, file);
		expect(() => archiveSessionFile("sid-4b", file, testRoot)).toThrow(/already exists/i);
		expect(existsSync(file)).toBe(true);
		expect(existsSync(dest)).toBe(true);
	});
});

describe("readArchivedSessions", () => {
	it("lists archived sessions with manifest timestamps and retention-derived expiry", async () => {
		const agentDir = join(testRoot, "list-manifest");
		const file = makeSession(agentDir, "proj-e", "listing");
		const dest = archiveSessionFile("sid-5", file, agentDir);
		const sessions = await readArchivedSessions(agentDir, 7);
		expect(sessions).toHaveLength(1);
		const found = sessions[0];
		expect(found.sessionFile).toBe(dest);
		expect(found.sessionId).toBe(SessionManager.open(dest).getSessionId());
		expect(found.messageCount).toBe(2);
		expect(found.expiresAt).toBe(found.archivedAt + 7 * 24 * 60 * 60 * 1000);
	});

	it("falls back to file mtime when the manifest entry is missing", async () => {
		const agentDir = join(testRoot, "list-mtime");
		const file = makeSession(agentDir, "proj-f", "no manifest");
		archiveSessionFile("sid-6", file, agentDir);
		await rm(join(agentDir, ARCHIVE_DIR_NAME, ARCHIVE_MANIFEST_FILE));
		const sessions = await readArchivedSessions(agentDir, null);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionFile).toContain("proj-f");
		expect(sessions[0].expiresAt).toBeNull();
	});
});

describe("purgeExpiredArchives", () => {
	it("deletes only archives past the retention window", async () => {
		const old = archiveSessionFile("sid-7", makeSession(testRoot, "proj-g", "old"), testRoot);
		const fresh = archiveSessionFile("sid-8", makeSession(testRoot, "proj-g", "fresh"), testRoot);
		const now = Date.now();
		manifestStore(testRoot).updateSync((m) => {
			if (m.sessions[old]) m.sessions[old].archivedAt = now - 8 * 24 * 60 * 60 * 1000;
			if (m.sessions[fresh]) m.sessions[fresh].archivedAt = now - 1 * 24 * 60 * 60 * 1000;
		});
		const purged = await purgeExpiredArchives(testRoot, 7, now);
		expect(purged).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("is a no-op with retention disabled", async () => {
		const file = archiveSessionFile("sid-9", makeSession(testRoot, "proj-h", "forever"), testRoot);
		manifestStore(testRoot).updateSync((m) => {
			if (m.sessions[file]) m.sessions[file].archivedAt = 0;
		});
		expect(await purgeExpiredArchives(testRoot, null, Date.now())).toBe(0);
		expect(existsSync(file)).toBe(true);
	});
});

describe("deleteArchivedSessionFile", () => {
	it("removes the file and manifest entry", () => {
		const dest = archiveSessionFile("sid-10", makeSession(testRoot, "proj-i", "delete me"), testRoot);
		deleteArchivedSessionFile(dest, testRoot);
		expect(existsSync(dest)).toBe(false);
		expect(manifestStore(testRoot).readSync().sessions[dest]).toBeUndefined();
	});
});

describe("reconcileArchiveManifest", () => {
	it("prunes manifest entries whose files are gone", () => {
		const dest = archiveSessionFile("sid-11", makeSession(testRoot, "proj-j", "reconcile"), testRoot);
		rmSync(dest);
		reconcileArchiveManifest(testRoot);
		expect(manifestStore(testRoot).readSync().sessions[dest]).toBeUndefined();
	});
});

describe("retention config", () => {
	it("round-trips days and explicit never", () => {
		writeArchiveRetentionDays(testRoot, 30);
		expect(readArchiveRetentionDays(testRoot)).toBe(30);
		writeArchiveRetentionDays(testRoot, null);
		expect(readArchiveRetentionDays(testRoot)).toBeNull();
	});

	it("defaults to 7 days when the key is missing", () => {
		writeArchiveRetentionDays(testRoot, 30);
		const store = new JsonStore<Record<string, unknown>>({
			path: join(testRoot, "settings.json"),
			defaultValue: () => ({}),
		});
		store.updateSync((existing) => {
			delete existing.archiveRetentionDays;
		});
		expect(readArchiveRetentionDays(testRoot)).toBe(7);
	});
});

describe("PiBackend archive facade", () => {
	it("archives, lists and restores through the backend", async () => {
		const agentDir = join(testRoot, "facade");
		const backend = new PiBackend({ agentDir, archiveSweeper: false });
		const file = makeSession(agentDir, "proj-k", "facade round trip");
		const sessionId = SessionManager.open(file).getSessionId();
		await backend.archiveSession(sessionId, file);
		expect(existsSync(file)).toBe(false);

		const archived = await backend.listArchivedSessions();
		expect(archived).toHaveLength(1);
		expect(archived[0].sessionId).toBe(sessionId);

		await backend.unarchiveSession(archived[0].sessionFile);
		expect(existsSync(file)).toBe(true);
		expect(await backend.listArchivedSessions()).toHaveLength(0);
	});

	it("persists retention config through the backend", async () => {
		const agentDir = join(testRoot, "facade-config");
		const backend = new PiBackend({ agentDir, archiveSweeper: false });
		expect(backend.getArchiveConfig().retentionDays).toBe(7);
		const saved = await backend.setArchiveRetention(90);
		expect(saved.retentionDays).toBe(90);
		expect(new PiBackend({ agentDir }).getArchiveConfig().retentionDays).toBe(90);
	});
});
