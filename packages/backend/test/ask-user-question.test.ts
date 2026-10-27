import type { AskUserQuestionRequest, AskUserQuestionResolved } from "@percho/shared";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	ASK_USER_TOOL_NAME,
	AskUserQuestionHost,
	buildAskUserResultText,
	makeAskUserQuestionTool,
} from "../src/tools/ask-user-question";

const QUESTIONS = [
	{
		question: "Which library?",
		header: "Lib",
		options: [
			{ label: "React", description: "big ecosystem" },
			{ label: "Preact", description: "small" },
		],
	},
	{
		question: "Which days?",
		options: [
			{ label: "Mon", description: "" },
			{ label: "Wed", description: "" },
		],
		multiSelect: true,
	},
];

function captureHost() {
	const requests: AskUserQuestionRequest[] = [];
	const resolved: AskUserQuestionResolved[] = [];
	const host = new AskUserQuestionHost({
		onRequest: (req) => requests.push(req),
		onResolved: (result) => resolved.push(result),
	});
	return { host, requests, resolved };
}

describe("AskUserQuestionHost", () => {
	it("dispatches request and resolves with answers", async () => {
		const { host, requests, resolved } = captureHost();
		host.bind("s1");
		const pending = host.ask(QUESTIONS);
		expect(requests).toHaveLength(1);
		expect(requests[0].id).toBe("ask-s1-0");
		expect(requests[0].sessionId).toBe("s1");
		expect(resolved).toHaveLength(0);
		host.respond("ask-s1-0", { answers: [{ selected: ["React"] }, { selected: ["Mon", "Wed"], custom: "也加周五" }] });
		await expect(pending).resolves.toEqual([
			{ selected: ["React"] },
			{ selected: ["Mon", "Wed"], custom: "也加周五" },
		]);
		expect(resolved[0]?.reason).toBe("answered");
	});

	it("cancel resolves undefined and is idempotent", async () => {
		const { host, resolved } = captureHost();
		host.bind("s1");
		const pending = host.ask(QUESTIONS);
		host.respond("ask-s1-0", { cancelled: true });
		host.respond("ask-s1-0", { cancelled: true });
		await expect(pending).resolves.toBeUndefined();
		expect(resolved).toHaveLength(1);
		// 未知 id 静默忽略
		host.respond("ask-s1-99", { cancelled: true });
	});

	it("abort settles as aborted", async () => {
		const { host, resolved } = captureHost();
		host.bind("s1");
		const controller = new AbortController();
		const pending = host.ask(QUESTIONS, controller.signal);
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(resolved[0]?.reason).toBe("aborted");
	});

	it("already-aborted signal never dispatches", async () => {
		const { host, requests } = captureHost();
		host.bind("s1");
		const controller = new AbortController();
		controller.abort();
		await expect(host.ask(QUESTIONS, controller.signal)).resolves.toBeUndefined();
		expect(requests).toHaveLength(0);
	});

	it("dispose settles pending as sessionClosed", async () => {
		const { host, resolved } = captureHost();
		host.bind("s1");
		const pending = host.ask(QUESTIONS);
		host.dispose();
		await expect(pending).resolves.toBeUndefined();
		expect(resolved[0]?.reason).toBe("sessionClosed");
	});
});

describe("ask_user_question tool", () => {
	it("builds answer text with selected labels and custom text", () => {
		const text = buildAskUserResultText(QUESTIONS, [
			{ selected: ["Preact"] },
			{ selected: ["Wed"], custom: "周五也可以" },
		]);
		expect(text).toContain("1. Which library?");
		expect(text).toContain("→ Preact");
		expect(text).toContain("→ Wed; 周五也可以");
	});

	it("returns decline envelope on cancel and answers envelope on respond", async () => {
		const { host } = captureHost();
		host.bind("s1");
		const tool = makeAskUserQuestionTool({ host });
		expect(tool.name).toBe(ASK_USER_TOOL_NAME);
		const defined = defineTool(tool);
		const controller = new AbortController();
		const run = defined.execute?.("t0", { questions: QUESTIONS }, controller.signal, () => {}, {
			cwd: "/tmp",
		} as never);
		controller.abort();
		const result = (await run) as { content: { text: string }[]; details: { cancelled: boolean } };
		expect(result.details.cancelled).toBe(true);
		expect(result.content[0]?.text).toContain("dismissed");
	});
});
