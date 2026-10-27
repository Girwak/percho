import type { PiBackend } from "@percho/backend";
import { ASK_USER_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 内置 ask_user_question 域：renderer 应答（请求/结算为 main→renderer 单向事件，在 index.ts 转发） */
export function registerAskUserIpc(backend: PiBackend): void {
	registerInvokeHandlers(ASK_USER_CHANNELS, {
		respondAskUserQuestion: ({ requestId, answer }) => backend.respondAskUserQuestion(requestId, answer),
	});
}
