import type { AskUserAnswer, AskUserQuestionRequest, AskUserQuestionRespond } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useTranscriptStore } from "../../stores/transcript";
import { HelpIcon } from "../icons";

/** 退出动画时长，与 globals.css 的 dock-exit 同步（同 InteractionDock） */
const EXIT_MS = 150;

/**
 * 内置 ask_user_question 问卷卡（与 InteractionDock 同语言：无边框 surface 圆角卡 +
 * accent glyph + 幽灵文字按钮）。逐题呈现：答完一题进下一题（上一题可回退修改），
 * 最后一题才提交整卷；任一步取消/中止即整卷取消——不伪造答案（诚实取消语义与宿主契约一致）。
 */
export function AskUserDock({ sessionId }: { sessionId: string | null }) {
	const t = useT();
	const pending = useTranscriptStore((s) => (sessionId ? s.bySession[sessionId]?.pendingAskUser : undefined));
	const resolveAskUser = useTranscriptStore((s) => s.resolveAskUser);
	const request = pending?.[0] ?? null;
	const queueCount = (pending?.length ?? 1) - 1;

	const [shown, setShown] = useState<AskUserQuestionRequest | null>(null);
	const [leaving, setLeaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	// 当前题号；每题已选选项下标 + 自定义文本（空串 = 未输入），跨步保留以便回退修改
	const [step, setStep] = useState(0);
	const [selections, setSelections] = useState<Set<number>[]>([]);
	const [customs, setCustoms] = useState<string[]>([]);
	const cardRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (request) {
			setShown(request);
			setLeaving(false);
			setError(null);
			setSending(false);
			setStep(0);
			setSelections(request.questions.map(() => new Set<number>()));
			setCustoms(request.questions.map(() => ""));
			return;
		}
		if (!shown) return;
		setLeaving(true);
		const timer = setTimeout(() => {
			setShown(null);
			setLeaving(false);
		}, EXIT_MS);
		return () => clearTimeout(timer);
	}, [request, shown]);

	useEffect(() => {
		if (shown && !leaving) cardRef.current?.focus();
	}, [shown, leaving, step]);

	const respond = useCallback(
		async (answer: AskUserQuestionRespond) => {
			if (!shown || leaving || !sessionId || sending) return;
			setSending(true);
			setError(null);
			try {
				await getPi().respondAskUserQuestion({ requestId: shown.id, answer });
				resolveAskUser(sessionId, shown.id);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSending(false);
			}
		},
		[shown, leaving, sessionId, sending, resolveAskUser],
	);

	if (!shown) return null;

	const total = shown.questions.length;
	const qi = Math.min(step, total - 1);
	const question = shown.questions[qi];
	const isLast = qi === total - 1;
	const stepAnswered = (selections[qi]?.size ?? 0) > 0 || (customs[qi] ?? "").trim() !== "";

	const toggleOption = (oi: number) => {
		setSelections((prev) => {
			const next = prev.map((s) => new Set(s));
			const set = next[qi];
			if (!set) return prev;
			if (question?.multiSelect) {
				if (set.has(oi)) set.delete(oi);
				else set.add(oi);
			} else {
				// 单选：点击已选项取消选择（允许只答自定义文本）
				set.clear();
				if (!prev[qi]?.has(oi)) set.add(oi);
			}
			return next;
		});
	};

	const setCustom = (value: string) => {
		setCustoms((prev) => prev.map((c, i) => (i === qi ? value : c)));
	};

	const submit = () => {
		const answers: AskUserAnswer[] = shown.questions.map((_, i) => {
			const labels = [...(selections[i] ?? [])].sort((a, b) => a - b).map((oi) => shown.questions[i]?.options[oi]?.label ?? "");
			const custom = (customs[i] ?? "").trim();
			return { selected: labels, ...(custom !== "" ? { custom } : {}) };
		});
		void respond({ answers });
	};

	const advance = () => {
		if (!stepAnswered) return;
		if (isLast) submit();
		else setStep(qi + 1);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			void respond({ cancelled: true });
		} else if (e.key === "Enter" && stepAnswered) {
			// 输入框内 Enter 已 stopPropagation，不会走到这里
			e.preventDefault();
			e.stopPropagation();
			advance();
		}
	};

	const option_ = question?.options ?? [];

	return (
		<div className="relative z-20 shrink-0 px-6 pb-3">
			<div className="mx-auto max-w-[760px]">
				<div
					key={shown.id}
					ref={cardRef}
					tabIndex={-1}
					role="dialog"
					aria-modal
					onKeyDown={onKeyDown}
					className={`dock-in flex flex-col gap-2.5 rounded-[14px] bg-surface px-3.5 pt-3 pb-2.5 shadow-soft outline-none ${
						leaving ? "dock-exit" : ""
					}`}
				>
					<div className="flex min-h-5 items-center gap-2">
						<span className="flex-none text-accent" aria-hidden="true">
							<HelpIcon />
						</span>
						<h3 className="min-w-0 flex-1 truncate text-ui-13 font-medium tracking-[-0.01em] text-ink-2">
							{t("askUser.title")}
						</h3>
						{total > 1 && (
							<span className="shrink-0 text-ui-11 text-ink-faint tabular-nums">
								{qi + 1} / {total}
							</span>
						)}
						{queueCount > 0 && (
							<span className="shrink-0 text-ui-11 text-ink-faint">{t("interaction.queueMore", { count: queueCount })}</span>
						)}
					</div>

					<div className="flex flex-col gap-1.5">
						<div className="flex items-baseline gap-2">
							{question?.header && (
								<span className="flex-none rounded-md bg-hover px-1.5 py-0.5 text-ui-105 font-medium text-ink-2">
									{question.header}
								</span>
							)}
							<p className="min-w-0 break-words text-ui-13 text-ink">{question?.question}</p>
						</div>
						<div className="-mx-1.5 flex flex-col gap-px">
							{option_.map((option, oi) => {
								const active = selections[qi]?.has(oi) ?? false;
								return (
									<button
										// biome-ignore lint/suspicious/noArrayIndexKey: 选项按下标即语义，应答数组与其对齐
										key={`${qi}-${oi}`}
										type="button"
										onClick={() => toggleOption(oi)}
										className={`flex items-start gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-ui-13 transition-colors ${
											active ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"
										}`}
									>
										<span
											aria-hidden="true"
											className={`mt-0.5 flex-none ${
												question?.multiSelect
													? `size-3 rounded-[3px] border ${active ? "border-accent bg-accent" : "border-border-strong"}`
													: `size-3 rounded-full border ${active ? "border-accent" : "border-border-strong"}`
											}`}
										>
											{active && !question?.multiSelect && <span className="mx-auto mt-0.5 block size-1.5 rounded-full bg-accent" />}
										</span>
										<span className="min-w-0">
											<span className="font-medium">{option.label}</span>
											<span className="block break-words text-ui-12 text-ink-faint">{option.description}</span>
										</span>
									</button>
								);
							})}
						</div>
						<input
							type="text"
							value={customs[qi] ?? ""}
							onChange={(e) => setCustom(e.currentTarget.value)}
							onKeyDown={(e) => e.stopPropagation()}
							placeholder={t("askUser.customPlaceholder")}
							className="min-w-0 border-b border-border bg-transparent px-0.5 py-1 text-ui-125 text-ink outline-none placeholder:text-ink-faint focus:border-accent"
						/>
					</div>

					{error && <p className="rounded-lg bg-hover px-2.5 py-1.5 text-ui-12 break-all text-err">{error}</p>}

					<div className="flex items-center gap-0.5">
						<span className="text-ui-11 text-ink-faint">{t("askUser.hint")}</span>
						<div className="ml-auto flex items-center gap-0.5">
							<button
								type="button"
								onClick={() => void respond({ cancelled: true })}
								className="rounded-[7px] px-2.5 py-1 text-ui-12 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
							>
								{t("interaction.cancel")}
							</button>
							{qi > 0 && (
								<button
									type="button"
									onClick={() => setStep(qi - 1)}
									className="rounded-[7px] px-2.5 py-1 text-ui-12 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
								>
									{t("askUser.back")}
								</button>
							)}
							<button
								type="button"
								onClick={advance}
								disabled={!stepAnswered || sending}
								className={`rounded-[7px] px-2.5 py-1 text-ui-12 transition-colors ${
									stepAnswered && !sending
										? "font-medium text-ink hover:bg-hover hover:text-ink"
										: "cursor-not-allowed text-ink-faint/60"
								}`}
							>
								{isLast ? t("interaction.submit") : t("askUser.next")}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
