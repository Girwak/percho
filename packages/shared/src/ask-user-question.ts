/**
 * 内置 ask_user_question 工具跨进程契约。
 *
 * 链路：模型调用工具 → backend AskUserQuestionHost（每会话一个，仿 ExtensionDialogHost）
 * → IPC 事件 → renderer 停靠槽（AskUserDock 逐题问卷）→ respond IPC → host resolve
 * → 工具结果回模型。与扩展对话框（extension-dialog.ts）平行的专用契约：多题同卡、
 * 多选复选、每题自定义答案——这些是通用 select/input 原语表达不了的。
 * 内容为模型生成的非受信文本，renderer 只做纯文本渲染。
 */

export interface AskUserOption {
	/** 简短显示文本（1-5 词） */
	label: string;
	/** 该选项的含义与取舍说明 */
	description: string;
}

export interface AskUserQuestionData {
	question: string;
	/** 短标签（≤16 字符），卡片内题头 chip */
	header?: string;
	options: AskUserOption[];
	/** true = 复选多选；缺省单选 */
	multiSelect?: boolean;
}

/** main → renderer：待应答问卷（整卡渲染数据源） */
export interface AskUserQuestionRequest {
	/** `ask-<sessionId>-<n>`，backend 单调递增 */
	id: string;
	sessionId: string;
	questions: AskUserQuestionData[];
	/** Date.now()，保留给将来倒计时显示 */
	requestedAt: number;
}

/** 每题作答：选中选项 label 集合 + 可选自定义文本（可并存；label 与 options[].label 精确匹配） */
export interface AskUserAnswer {
	selected: string[];
	custom?: string;
}

/** renderer → main 的应答载荷（取消时宿主按 dismiss 结算） */
export type AskUserQuestionRespond = { answers: AskUserAnswer[] } | { cancelled: true };

/** main → renderer：已结算（应答/中止/会话关闭都广播，renderer 撤卡） */
export interface AskUserQuestionResolved {
	sessionId: string;
	requestId: string;
	/** answered=用户现场作答（含主动取消）；其余为系统裁决 */
	reason: "answered" | "aborted" | "sessionClosed";
}
