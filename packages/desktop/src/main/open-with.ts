import { execFile, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenToolId } from "@percho/shared";
import { shell } from "electron";
import { resolveExistingPath } from "./path-target";

/**
 * 「打开项目目录」目标检测与启动（顶栏 OpenButton 的后端）。
 *
 * 检测全在主进程：`where`/`which`（PATH 上找 CLI）+ 常见安装路径兜底，结果模块级缓存
 * （工具安装状态在单次运行内视为不变，进程重启才会重查）。fileManager 走 shell.openPath
 * 恒可用；其余检测到才出现在菜单。外部程序一律 detached + stdio ignore 启动，不随本应用退出。
 */

const WHICH_TIMEOUT_MS = 1500;
const WHICH = process.platform === "win32" ? "where" : "which";

/** PATH 上查命令，返回全部命中（`where` 可能多行） */
function pathsOf(command: string): Promise<string[]> {
	return new Promise((resolve) => {
		execFile(WHICH, [command], { timeout: WHICH_TIMEOUT_MS }, (error, stdout) => {
			if (error) resolve([]);
			else
				resolve(
					stdout
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean),
				);
		});
	});
}

/** PATH 上查命令的第一个可执行路径。win 必须过滤：`where code` 会把无扩展名的 sh 包装脚本
 *  （git-bash 用，Windows spawn 不了 → ENOENT）排在 `code.cmd` 前面，只认 .cmd/.exe */
async function firstExePath(command: string): Promise<string | null> {
	const hits = await pathsOf(command);
	if (process.platform !== "win32") return hits[0] ?? null;
	return hits.find((p) => /\.cmd$/i.test(p)) ?? hits.find((p) => /\.exe$/i.test(p)) ?? null;
}

/** detached 启动外部程序；spawn 失败（ENOENT 等）是异步 error 事件，必须接住转 reject
 *  （否则 uncaught exception 直接炸主进程），经 IPC 透到渲染端弹 toast */
function spawnDetached(command: string, args: readonly string[], options?: SpawnOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
		child.once("error", reject);
		child.once("spawn", () => {
			child.off("error", reject);
			child.unref();
			resolve();
		});
	});
}

/** 命中第一个存在的候选路径（PATH 外的常见安装位置兜底） */
function existingOf(paths: readonly string[]): string | null {
	return paths.find((p) => p && existsSync(p)) ?? null;
}

/** VS Code CLI 的常见安装位置（PATH 上没有 `code` 时兜底） */
const VS_CODE_FALLBACKS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
	win32: [
		join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
		"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
		"C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd",
	],
	darwin: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
	linux: ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"],
};

/** Git Bash 的常见安装位置（仅 Windows） */
const GIT_BASH_PATHS = [
	"C:\\Program Files\\Git\\git-bash.exe",
	"C:\\Program Files (x86)\\Git\\git-bash.exe",
	join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "git-bash.exe"),
];

/** Linux 终端：探测顺序 + 各自「落到指定目录」的参数（未列出参数形态的靠子进程 cwd 继承） */
const LINUX_TERMINALS: readonly {
	command: string;
	dirArgs?: (cwd: string) => readonly string[];
}[] = [
	{ command: "x-terminal-emulator" },
	{ command: "gnome-terminal", dirArgs: (cwd) => [`--working-directory=${cwd}`] },
	{ command: "konsole", dirArgs: (cwd) => ["--workdir", cwd] },
	{ command: "xfce4-terminal", dirArgs: (cwd) => [`--default-working-directory=${cwd}`] },
	{ command: "kitty", dirArgs: (cwd) => ["--directory", cwd] },
	{ command: "alacritty", dirArgs: (cwd) => ["--working-directory", cwd] },
];

/** terminal 目标的启动形态（决定 openWithTool 里的分支） */
type TerminalFlavor = "wt" | "cmd" | "open" | "generic";

/** launcher 绝对路径表；fileManager 无独立可执行文件，用占位串标记可用 */
type Launchers = Partial<Record<OpenToolId, string>>;

let cachedLaunchers: Promise<Launchers> | null = null;
let terminalFlavor: TerminalFlavor = "generic";
/** Linux 命中的终端的落目录参数构造器（null = 只靠 cwd 继承） */
let linuxTerminalDirArgs: ((cwd: string) => readonly string[]) | null = null;

function resolveLaunchers(): Promise<Launchers> {
	cachedLaunchers ??= (async () => {
		const platform = process.platform;
		const launchers: Launchers = { fileManager: "shell.openPath" };
		// 暂只放开 win32：下方 darwin/linux 的检测/启动分支保留但未实测（开发机无法验证），
		// 先屏蔽防误用；要恢复时删掉这行短路即可
		if (platform !== "win32") return launchers;
		const code = (await firstExePath("code")) ?? existingOf(VS_CODE_FALLBACKS[platform] ?? []);
		if (code) launchers.vscode = code;
		if (platform === "win32") {
			const gitBash = existingOf(GIT_BASH_PATHS);
			if (gitBash) launchers.gitBash = gitBash;
			// 有 Windows Terminal 优先，否则 cmd（ComSpec 恒在 ⇒ terminal 恒可用）
			const wt = await firstExePath("wt");
			terminalFlavor = wt ? "wt" : "cmd";
			launchers.terminal = wt ?? process.env.ComSpec ?? "cmd.exe";
		} else if (platform === "darwin") {
			terminalFlavor = "open";
			launchers.terminal = "/usr/bin/open";
		} else {
			for (const { command, dirArgs } of LINUX_TERMINALS) {
				const path = await firstExePath(command);
				if (path) {
					terminalFlavor = "generic";
					linuxTerminalDirArgs = dirArgs ? (cwd) => dirArgs(cwd) : null;
					launchers.terminal = path;
					break;
				}
			}
		}
		return launchers;
	})();
	return cachedLaunchers;
}

/** 可用目标（菜单渲染顺序 = 表插入顺序：文件管理器 → VS Code → Git Bash → 终端） */
export async function listOpenTools(): Promise<OpenToolId[]> {
	const launchers = await resolveLaunchers();
	return (Object.keys(launchers) as OpenToolId[]).filter((id) => launchers[id] !== undefined);
}

/** 用指定工具打开项目根目录；目录不存在或目标未检测到抛错（渲染端 toast） */
export async function openWithTool(rawCwd: string, tool: OpenToolId): Promise<void> {
	const cwd = resolveExistingPath(rawCwd, null);
	const target = (await resolveLaunchers())[tool];
	if (!target) throw new Error(`Open target unavailable: ${tool}`);

	const detached = { detached: true, stdio: "ignore" as const };
	switch (tool) {
		case "fileManager": {
			const error = await shell.openPath(cwd);
			if (error) throw new Error(error);
			return;
		}
		case "vscode": {
			// win 命中的多是 code.cmd（Node spawn 直接跑 .cmd 会 EINVAL）→ 优先换同目录的 Code.exe，兜底 cmd /c
			let exe = target;
			if (process.platform === "win32" && exe.toLowerCase().endsWith(".cmd")) {
				const codeExe = join(dirname(exe), "..", "Code.exe");
				if (existsSync(codeExe)) exe = codeExe;
			}
			if (exe.toLowerCase().endsWith(".cmd")) await spawnDetached("cmd.exe", ["/c", exe, cwd]);
			else await spawnDetached(exe, [cwd]);
			return;
		}
		case "gitBash":
			await spawnDetached(target, [`--cd=${cwd}`]);
			return;
		case "terminal":
			if (terminalFlavor === "open") await spawnDetached(target, ["-a", "Terminal", cwd]);
			else if (terminalFlavor === "wt") await spawnDetached(target, ["-d", cwd]);
			// cmd / Linux 通用终端：子进程 cwd 即工作目录（cmd 无额外参数，Linux 按终端给落目录参数）
			else await spawnDetached(target, [...(linuxTerminalDirArgs?.(cwd) ?? [])], { ...detached, cwd });
			return;
	}
}
