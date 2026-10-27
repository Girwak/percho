import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	AskUserAnswer,
	AskUserQuestionData,
	AskUserQuestionRequest,
	AskUserQuestionResolved,
	AskUserQuestionRespond,
} from "@percho/shared";
import { Type } from "typebox";

/** 工具名（与社区 rpiv 插件同名：customTools 后写覆盖，见 pi-backend 遮蔽日志） */
export const ASK_USER_TOOL_NAME = "ask_user_question";

/** 问卷规模上限（每题 2-4 选项），防模型一次铺满屏幕 */
const MAX_QUESTIONS = 9;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// ---------------------------------------------------------------------------
// 每会话宿主（仿 ExtensionDialogHost：pending 表 + 幂等结算 + dispose 兜底）。
// 无 timeout——提问天然等用户回来；abort（停止生成）与会话关闭是唯一系统裁决。
// ---------------------------------------------------------------------------

export type AskUserRequestListener = (req: AskUserQuestionRequest) => void;
export type AskUserResolvedListener = (result: AskUserQuestionResolved) => void;

interface PendingEntry {
	request: AskUserQuestionRequest;
	resolve: (answers: AskUserAnswer[] | undefined) => void;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
	/** 幂等闸：应答/abort/关闭竞态只取第一个 */
	settled: boolean;
}

export class AskUserQuestionHost {
	private readonly pending = new Map<string, PendingEntry>();
	private sessionId = "";
	private seq = 0;

	constructor(
		private readonly listeners: { onRequest: AskUserRequestListener; onResolved: AskUserResolvedListener },
	) {}

	/** 会话创建后才能确定 sessionId，创建后绑定（仿 gate.bindSession 两步构造） */
	bind(sessionId: string): void {
		this.sessionId = sessionId;
	}

	/** 工具 execute 入口；undefined = 用户取消（诚实取消，绝不伪造答案） */
	ask(questions: AskUserQuestionData[], signal?: AbortSignal): Promise<AskUserAnswer[] | undefined> {
		const id = `ask-${this.sessionId}-${this.seq++}`;
		const request: AskUserQuestionRequest = {
			id,
			sessionId: this.sessionId,
			questions,
			requestedAt: Date.now(),
		};
		if (signal?.aborted) {
			this.listeners.onResolved({ sessionId: this.sessionId, requestId: id, reason: "aborted" });
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => {
			const entry: PendingEntry = { request, resolve, signal, onAbort: undefined, settled: false };
			if (signal) {
				entry.onAbort = () => this.settle(id, "aborted", undefined);
				signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			this.pending.set(id, entry);
			this.listeners.onRequest(request);
		});
	}

	/** 用户应答（renderer IPC）；未知 id / 重复结算静默忽略（与对话框宿主同语义） */
	respond(requestId: string, answer: AskUserQuestionRespond): void {
		const entry = this.pending.get(requestId);
		if (!entry || entry.settled) return;
		if ("cancelled" in answer) {
			this.settle(requestId, "answered", undefined);
			return;
		}
		this.settle(requestId, "answered", answer.answers);
	}

	/** 会话关闭兜底：全部按 sessionClosed 结算（工具 Promise 落取消，agent 不悬挂） */
	dispose(): void {
		for (const id of [...this.pending.keys()]) this.settle(id, "sessionClosed", undefined);
	}

	private settle(
		requestId: string,
		reason: AskUserQuestionResolved["reason"],
		answers: AskUserAnswer[] | undefined,
	): void {
		const entry = this.pending.get(requestId);
		if (!entry || entry.settled) return;
		entry.settled = true;
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
		this.pending.delete(requestId);
		entry.resolve(answers);
		this.listeners.onResolved({ sessionId: entry.request.sessionId, requestId, reason });
	}
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const askUserParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The complete question, ending with a question mark." }),
			header: Type.Optional(
				Type.String({ description: "Short chip/tag shown next to the question. MAX 16 CHARACTERS." }),
			),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "Concise display text (1-5 words)." }),
					description: Type.String({ description: "What this choice means or its trade-offs." }),
				}),
				{
					minItems: MIN_OPTIONS,
					maxItems: MAX_OPTIONS,
					description: "2-4 distinct, mutually exclusive options (unless multiSelect).",
				},
			),
			multiSelect: Type.Optional(
				Type.Boolean({ description: "true when multiple answers are valid; single-select otherwise." }),
			),
		}),
		{ minItems: 1, maxItems: MAX_QUESTIONS, description: "Up to 9 questions, presented to the user one at a time." },
	),
});

/** 模型可读的结果文本（取消=明确拒绝语义，绝不当作错误或默认答案） */
export function buildAskUserResultText(questions: AskUserQuestionData[], answers: AskUserAnswer[]): string {
	return questions
		.map((q, i) => {
			const a = answers[i];
			const parts = [...(a?.selected ?? []), ...(a?.custom ? [a.custom] : [])];
			return `${i + 1}. ${q.question}\n   → ${parts.length > 0 ? parts.join("; ") : "(no answer)"}`;
		})
		.join("\n");
}

/**
 * 内置 ask_user_question 工具：歧义或需要用户拍板时，把 1-4 道结构化选择题
 * 逐题呈现在 GUI（复选多选 + 每题自定义答案，最后一题提交整卷）。
 * 纯 UI 交互不动环境（readOnlyHint）；同名第三方扩展工具由 customTools 后写覆盖接管。
 */
export function makeAskUserQuestionTool(deps: {
	host: AskUserQuestionHost;
}): ToolDefinition<typeof askUserParams> {
	return defineTool({
		name: ASK_USER_TOOL_NAME,
		annotations: { readOnlyHint: true },
		label: "Ask User",
		description:
			"Ask the user structured questions (each with 2-4 options) instead of guessing. Use when requirements are ambiguous, a key decision needs the user, or you need user preferences. The user can always type a custom answer instead of picking an option. Do NOT use for simple yes/no confirmations — ask those in plain chat text.",
		promptGuidelines: [
			"Each question MUST have 2-4 options with concise labels and descriptions explaining the trade-offs.",
			"The user can additionally type a custom answer on every question.",
			'If you recommend an option, put it first and append " (Recommended)" to its label.',
			"Group all clarifying questions into one call instead of asking repeatedly.",
		],
		parameters: askUserParams,
		execute: async (
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<{ cancelled: boolean; answers?: AskUserAnswer[] }>> => {
			const answers = await deps.host.ask(params.questions, signal ?? undefined);
			if (!answers) {
				return {
					content: [
						{
							type: "text",
							text: "User dismissed the questionnaire without answering. Treat this as a decline — do not retry the same questions; proceed with your best judgment or ask in plain chat text.",
						},
					],
					details: { cancelled: true },
				};
			}
			return {
				content: [
					{ type: "text", text: `User answered:\n${buildAskUserResultText(params.questions, answers)}` },
				],
				details: { cancelled: false, answers },
			};
		},
	});
}
