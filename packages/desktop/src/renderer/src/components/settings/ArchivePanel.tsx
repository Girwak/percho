import type { ArchivedSessionMeta } from "@percho/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { pathLastSegment } from "../../lib/path-display";
import { useProjectsStore } from "../../stores/projects";
import { useToastsStore } from "../../stores/toasts";
import { ArchiveIcon, TrashIcon, UndoIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";

const RETENTION_OPTIONS = [
	{ days: 7, labelKey: "retention7" },
	{ days: 30, labelKey: "retention30" },
	{ days: 90, labelKey: "retention90" },
	{ days: null, labelKey: "retentionNever" },
] as const;

function formatTime(ts: number): string {
	return new Date(ts).toLocaleString(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function ArchivePanel() {
	const t = useT();
	const push = useToastsStore((s) => s.push);
	const [retention, setRetention] = useState<number | null | undefined>(undefined);
	const [sessions, setSessions] = useState<ArchivedSessionMeta[] | null>(null);
	const [busyFile, setBusyFile] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ArchivedSessionMeta | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [config, list] = await Promise.all([getPi().getArchiveConfig(), getPi().listArchivedSessions()]);
			setRetention(config.retentionDays);
			setSessions(list);
		} catch {
			setSessions((prev) => prev ?? []);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const groups = useMemo(() => {
		const byCwd = new Map<string, ArchivedSessionMeta[]>();
		for (const session of sessions ?? []) {
			const bucket = byCwd.get(session.cwd);
			if (bucket) bucket.push(session);
			else byCwd.set(session.cwd, [session]);
		}
		return [...byCwd.entries()].map(([cwd, items]) => ({
			cwd,
			name: pathLastSegment(cwd) ?? cwd,
			items,
		}));
	}, [sessions]);

	const changeRetention = async (days: number | null) => {
		if (retention === days) return;
		const previous = retention;
		setRetention(days);
		try {
			await getPi().setArchiveRetention({ days });
		} catch {
			setRetention(previous);
			push("error", "toast.archiveRetentionSaveFailed");
		}
	};

	const restore = async (session: ArchivedSessionMeta) => {
		setBusyFile(session.sessionFile);
		try {
			await getPi().unarchiveSession({ sessionFile: session.sessionFile });
			void useProjectsStore.getState().load();
			await refresh();
		} catch {
			push("error", "toast.sessionUnarchiveFailed");
		} finally {
			setBusyFile(null);
		}
	};

	const confirmDelete = async () => {
		const session = deleting;
		if (!session) return;
		setDeleting(null);
		setBusyFile(session.sessionFile);
		try {
			await getPi().deleteArchivedSession({ sessionFile: session.sessionFile });
			await refresh();
		} catch {
			push("error", "toast.archiveDeleteFailed");
		} finally {
			setBusyFile(null);
		}
	};

	const purgeNow = async () => {
		try {
			const count = await getPi().purgeExpiredArchived();
			push("info", count > 0 ? "toast.archivePurgeDone" : "toast.archivePurgeNone");
			await refresh();
		} catch {
			push("error", "toast.archivePurgeFailed");
		}
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.archive.title")}</h3>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">{t("settings.archive.hint")}</p>
			</div>

			<div className="flex items-center justify-between gap-4">
				<div>
					<div className="text-ui-12 font-medium text-ink">{t("settings.archive.retention")}</div>
					<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
						{t("settings.archive.retentionHint")}
					</p>
				</div>
				<div className="flex shrink-0 gap-1">
					{RETENTION_OPTIONS.map((option) => (
						<button
							key={option.labelKey}
							type="button"
							disabled={retention === undefined}
							className={`rounded-md border px-2.5 py-1 text-ui-11 transition-colors ${
								retention === option.days
									? "border-ink/30 bg-hover font-medium text-ink"
									: "border-border text-ink-dim hover:bg-hover hover:text-ink"
							}`}
							onClick={() => void changeRetention(option.days)}
						>
							{t(`settings.archive.${option.labelKey}`)}
						</button>
					))}
				</div>
			</div>

			<div className="flex items-center justify-between border-t border-border/60 pt-3">
				<div className="flex items-center gap-1.5 text-ui-11 text-ink-dim">
					<ArchiveIcon size={13} />
					<span>{t("settings.archive.sessionsCount", { count: sessions?.length ?? 0 })}</span>
				</div>
				<button
					type="button"
					className="rounded-md border border-border px-2 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover disabled:opacity-50"
					disabled={retention === null || !sessions?.length}
					onClick={() => void purgeNow()}
				>
					{t("settings.archive.purgeNow")}
				</button>
			</div>

			{sessions === null ? (
				<p className="py-6 text-center text-ui-12 text-ink-faint">{t("settings.archive.loading")}</p>
			) : sessions.length === 0 ? (
				<p className="py-6 text-center text-ui-12 text-ink-faint">{t("settings.archive.empty")}</p>
			) : (
				<div className="flex flex-col gap-4">
					{groups.map((group) => (
						<div key={group.cwd} className="flex flex-col gap-1">
							<div className="flex items-baseline justify-between px-1">
								<span className="truncate text-ui-12 font-medium text-ink-2" title={group.cwd}>
									{group.name}
								</span>
								<span className="shrink-0 pl-2 text-ui-11 text-ink-faint">
									{t("settings.archive.sessionsCount", { count: group.items.length })}
								</span>
							</div>
							<div className="overflow-hidden rounded-lg border border-border bg-surface">
								{group.items.map((session, index) => {
									return (
										<div
											key={session.sessionFile}
											className={`flex items-center justify-between gap-3 px-3 py-2 ${
												index > 0 ? "border-t border-border/60" : ""
											}`}
										>
											<div className="min-w-0">
												<div className="truncate text-ui-12 text-ink">
													{session.name ?? session.sessionId.slice(0, 8)}
												</div>
												<div className="mt-0.5 truncate text-ui-11 text-ink-faint">
													{t("settings.archive.archivedAt", { time: formatTime(session.archivedAt) })}
													{" · "}
													{session.expiresAt === null
														? t("settings.archive.expiresNever")
														: t("settings.archive.expiresAt", {
																time: formatTime(session.expiresAt),
															})}
												</div>
											</div>
											<div className="flex shrink-0 gap-1">
												<button
													type="button"
													className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover disabled:opacity-50"
													disabled={busyFile !== null}
													onClick={() => void restore(session)}
												>
													<UndoIcon size={12} />
													{t("settings.archive.restore")}
												</button>
												<button
													type="button"
													className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ui-11 text-red-500 transition-colors hover:bg-hover disabled:opacity-50"
													disabled={busyFile !== null}
													onClick={() => setDeleting(session)}
												>
													<TrashIcon size={12} />
													{t("settings.archive.delete")}
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					))}
				</div>
			)}

			{deleting && (
				<ConfirmDialog
					title={t("settings.archive.deleteTitle")}
					description={t("settings.archive.deleteDesc")}
					confirmLabel={t("settings.archive.delete")}
					cancelLabel={t("common.cancel")}
					danger
					onConfirm={() => void confirmDelete()}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
