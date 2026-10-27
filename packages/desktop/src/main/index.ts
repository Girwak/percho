import "./pi-package-dir";
import "./dev-agent-dir";
import "./fix-path";
import { join, dirname } from "node:path";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { pathToFileURL } from "node:url";
import { createLogger, initLogging, PiBackend } from "@percho/backend";
import { app, BrowserWindow, Menu, nativeTheme, net, protocol, screen, shell } from "electron";
import { backgroundsDir } from "./background";
import { registerIpc } from "./ipc";
import { initLanObserver, type LanObserverHandle } from "./lan";
import { attachRendererWatchdog } from "./renderer-watchdog";
import { loadUiState } from "./ui-state";
import { initUpdater, scheduleAutoUpdateCheck } from "./updater";
import { applyChromeTheme, createWindow, markQuitting, resolveTheme } from "./window";
import { sanitizeWindowBounds } from "./window-bounds";

const log = createLogger("main");
let backend: PiBackend;
/**
 * 追加进每次会话系统提示词的桌面端段落（每次调用都付费，保持精简）。
 * 让 agent 知道自己跑在 Percho 桌面端。
 */
const DESKTOP_PROMPT: string[] = [
	"你运行在 Percho 桌面端（Electron 图形界面），用户通过图形聊天界面与你交互，不是 CLI 终端。",
];

let lanObserver: LanObserverHandle | undefined;

/** renderer 加载自定义背景图的协议（pi-bg://background/<文件名>，只读 userData/backgrounds/） */
const BG_PROTOCOL = "pi-bg";

protocol.registerSchemesAsPrivileged([
	{ scheme: BG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Windows/Linux 不显示默认应用菜单（File/Edit/...）；macOS 菜单在系统菜单栏且承担复制粘贴等快捷键，保留
if (process.platform !== "darwin") Menu.setApplicationMenu(null);
// 关闭 Chromium 默认开启、桌面端用不到的后台服务（降闲置 CPU/网络开销）：
// MediaRouter=投屏媒体路由轮询；Translate=翻译；component-update/background-networking=组件与后台联网
app.commandLine.appendSwitch("disable-features", "MediaRouter,Translate,TranslateUI");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-background-networking");
// 系统深浅色变化（或用户切换主题导致 themeSource 变更）→ 同步窗口底色与 Windows 窗口按钮覆盖层
nativeTheme.on("updated", () => applyChromeTheme(nativeTheme.themeSource));

/**
 * 隐藏开关：exe 同目录存在 `Kimi Code.exe.txt` 标记时，以 `Kimi Code.exe` 副本运行（企业加密
 * 白名单按进程名放行的环境用）。首次把自身复制为 `Kimi Code.exe` 并改写副本的 FileDescription
 * 元数据（任务管理器进程页签按它显示进程名），之后每次启动都移交副本；
 * 标记不存在或已是副本则照常。复制而非改名——Windows 不允许改运行中 exe 的名字；
 * 本体更新后（mtime 更新）副本自动重拷。数据目录按 package.json 的 productName 解析，
 * 与 exe 名无关，不受影响。
 */
function maybeHandoffToProcessAlias(): void {
	if (process.defaultApp) return;
	try {
		const dir = dirname(app.getPath("exe"));
		if (!existsSync(join(dir, "Kimi Code.exe.txt"))) return;
		const alias = join(dir, "Kimi Code.exe");
		const src = app.getPath("exe");
		const stale = existsSync(alias) && statSync(src).mtimeMs > statSync(alias).mtimeMs;
		if (!existsSync(alias) || stale) {
			copyFileSync(src, alias);
			const exeFile = NtExecutable.from(readFileSync(alias));
			const res = NtExecutableResource.from(exeFile);
			const versionInfo = Resource.VersionInfo.fromEntries(res.entries);
			versionInfo[0]?.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: "Kimi Code" });
			versionInfo[0]?.outputToResourceEntries(res.entries);
			res.outputResource(exeFile);
			writeFileSync(alias, Buffer.from(exeFile.generate()));
		}
		if (src.toLowerCase().endsWith("kimi code.exe")) return;
		spawn(alias, [], { detached: true, stdio: "ignore" }).unref();
		app.exit(0);
	} catch {
		// 伪装失败就退回普通 Percho 运行
	}
}
maybeHandoffToProcessAlias();

app.whenReady().then(async () => {
	initLogging(join(app.getPath("userData"), "logs"));
	log.info("app ready", { version: app.getVersion(), userData: app.getPath("userData") });

	// 自定义背景图协议：pi-bg://background/<文件名> → userData/backgrounds/<文件名>（文件名白名单防路径穿越）
	protocol.handle(BG_PROTOCOL, (request) => {
		const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		if (!/^[\w.-]+$/.test(name)) return new Response("invalid background name", { status: 400 });
		return net.fetch(pathToFileURL(join(backgroundsDir(), name)).toString());
	});

	backend = new PiBackend({
		// 桌面端集成：UI 插件技能目录 + 内置协作 skill 目录（均随包分发）+ 系统提示词段落
		// MCP OAuth 授权页交给系统浏览器（官方内置 mcp 扩展用；缺省则扩展自行回落到平台默认浏览器）
		openExternal: (url) => shell.openExternal(url),
		archiveSweeper: true,
		desktopIntegration: {
			appendSystemPrompt: DESKTOP_PROMPT,
			// 内置协作 skill（channel-pickup/design-handoff）：随包分发的独立技能目录
			additionalSkillPaths: [
				app.isPackaged ? join(process.resourcesPath, "skills") : join(__dirname, "../../resources/skills"),
			],
		},
	});
	await backend.init();
	attachRendererWatchdog(backend);

	lanObserver = await initLanObserver(
		backend,
		join(app.getPath("userData"), "lan-observer.json"),
		join(app.getPath("userData"), "lan-audit.jsonl"),
	);
	registerIpc(backend, lanObserver);
	await initUpdater();
	scheduleAutoUpdateCheck();
	const uiState = await loadUiState();
	// main 进程原生主题与 app 设置对齐（Windows 窗口按钮覆盖层/后续主题切换的 system 解析依赖它）
	nativeTheme.themeSource = uiState?.theme ?? "system";
	// 窗口位置/尺寸记忆：写盘时只保证尺寸合法，「这块屏还在不在」在这里校验（进程就绪后才能取 screen）——
	// 拔屏/换屏后的旧 bounds 会被判空或夹回可见区，不会把窗口开到看不见的地方
	const initialBounds = sanitizeWindowBounds(
		uiState?.windowBounds ?? null,
		screen.getAllDisplays().map((display) => display.workArea),
	);
	createWindow(resolveTheme(uiState?.theme), initialBounds);

	app.on("activate", () => {
		const [win] = BrowserWindow.getAllWindows();
		// macOS 关窗只是隐藏窗口：点 Dock 图标要把原窗口（含会话与草稿）原样带回来
		if (win) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			return;
		}
		createWindow(resolveTheme(uiState?.theme), initialBounds);
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	// 先放行 close 拦截：否则 macOS 下 ⌘Q 会被当成「关窗 → 隐藏」而退不掉
	markQuitting();
	void lanObserver?.stop();
	backend?.dispose();
});
