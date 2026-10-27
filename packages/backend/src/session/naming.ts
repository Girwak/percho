import { open } from "node:fs/promises";
import type { AgentSession, AgentSessionEvent, SessionInfo } from "@earendil-works/pi-coding-agent";
import { formatSkillCommand, parseExpandedSkillInvocation } from "@percho/shared";
import { isSubagentSessionPath } from "../tools/subagent";

/** pi 无自动命名逻辑：第一条用户消息到达即取首行作为会话标题（不等 agent_end，顶栏标题即时更新）。
 *  skill 命令此时已被 SDK 展开成 <skill …>canonical 正文——先还原成 /skill:name args 再取首行，
 *  与用户消息气泡/复制按钮的展示投影同一套（标题不再是无信息量的 XML 头）。 */
export function autoNameSession(session: AgentSession, event: AgentSessionEvent): void {
	if (event.type !== "message_start") return;
	if (session.sessionManager.getSessionName()) return;
	const message = event.message;
	if (message.role !== "user") return;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((p) => p.type === "text")
					.map((p) => ("text" in p ? p.text : ""))
					.join(" ");
	const title = sessionTitleFromUserText(text);
	if (title) session.setSessionName(title);
}

/** 首条用户消息文本 → 会话标题（30 字截断）。autoNameSession 与目录枚举的离线推导共用同一规则 */
export function sessionTitleFromUserText(text: string): string | undefined {
	const invocation = parseExpandedSkillInvocation(text);
	const firstLine = invocation
		? (formatSkillCommand(invocation).split("\n")[0] ?? "").trim()
		: (text.trim().split("\n")[0] ?? "").trim();
	if (!firstLine) return undefined;
	return firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine;
}

/** 目录枚举时无名会话的标题离线推导：只读文件头部 16KB，找第一条用户消息文本。
 *  头部找不到（首条消息特别长/前段全是非文本 part）→ undefined，调用方保留目录名回退。 */
const TITLE_PEEK_BYTES = 16 * 1024;

export async function peekSessionTitle(filePath: string): Promise<string | undefined> {
	const handle = await open(filePath, "r").catch(() => undefined);
	if (!handle) return undefined;
	try {
		const buf = Buffer.alloc(TITLE_PEEK_BYTES);
		const { bytesRead } = await handle.read(buf, 0, TITLE_PEEK_BYTES, 0);
		for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n")) {
			let entry: { message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue; // 截断行/非 JSON 跳过
			}
			const message = entry.message;
			if (message?.role !== "user") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content
								.filter((p) => (p as { type?: string }).type === "text")
								.map((p) => (p as { text?: string }).text ?? "")
								.join(" ")
						: "";
			const title = sessionTitleFromUserText(text);
			if (title) return title;
			// 首条用户消息无文本（如纯图片附件）→ 继续找下一条用户消息
		}
		return undefined;
	} finally {
		await handle.close().catch(() => {});
	}
}

/** 目录枚举后补名：无名会话（CLI 创建/老会话）从 JSONL 头部离线推导标题（仅展示用，不写会话文件）。
 *  SessionInfo.messageCount 已有（SDK 枚举读全文件），标题只看头部 16KB，成本可忽略。 */
export const SESSION_TITLE_PROMPT =
	"根据这个用户请求，生成一个会话标题。要求：只包含汉字、字母或数字，不超过8个字，不要标点符号、空格或任何解释，只输出标题本身。";

/** 提取用户消息文本（string 或 parts 数组统一处理） */
export function userTextOf(message: { role: string; content: unknown } | undefined): string {
	if (message?.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((p) => (p as { type?: string }).type === "text")
				.map((p) => (p as { text?: string }).text ?? "")
				.join(" ")
		: "";
}

/** 提取助手消息文本（AI 标题调用结果） */
export function assistantTextOf(message: { content: unknown } | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((p) => (p as { type?: string }).type === "text")
				.map((p) => (p as { text?: string }).text ?? "")
				.join("")
		: "";
}

/** AI 生成标题清洗：只保留汉字/字母/数字（去标点、空白与装饰符），截 8 字 */
export function sanitizeAiTitle(raw: string): string | undefined {
	const cleaned = raw.replace(/[^\p{L}\p{N}]/gu, "");
	if (!cleaned) return undefined;
	return cleaned.slice(0, 8);
}

export async function fillMissingSessionNames(infos: SessionInfo[]): Promise<void> {
	const missing = infos.filter((info) => !info.name && info.path && !isSubagentSessionPath(info.path));
	if (missing.length === 0) return;
	const titles = await Promise.all(missing.map((info) => peekSessionTitle(info.path)));
	missing.forEach((info, i) => {
		const title = titles[i];
		if (title) info.name = title;
	});
}
