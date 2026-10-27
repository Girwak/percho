import type { PiBackend } from "@percho/backend";
import { IpcChannels } from "@percho/shared";
import type { LanObserverHandle } from "../lan";
import { onUpdateState } from "../updater";
import { registerAppIpc } from "./app";
import { registerAskUserIpc } from "./ask-user";
import { registerExtensionDialogIpc } from "./extension-dialogs";
import { registerLanIpc } from "./lan";
import { registerPackagesIpc } from "./packages";
import { forward, sendToRenderer } from "./send";
import { registerSessionsIpc } from "./sessions";
import { registerSettingsIpc } from "./settings";

/**
 * IPC 注册组合入口：按域拆在 ./sessions ./settings ./packages ./app ./ask-user 等文件，
 * 这里只做拼装 + backend/updater 事件转发到 renderer。
 */
export function registerIpc(
	backend: PiBackend,
	lan: LanObserverHandle,
): void {
	registerSessionsIpc(backend);
	registerSettingsIpc(backend);
	registerPackagesIpc(backend);
	registerAppIpc(backend);
	registerExtensionDialogIpc(backend);
	registerAskUserIpc(backend);
	registerLanIpc(lan);

	// onEvent 载荷是 (sessionId, event) → 信封封装，不透明传，单行保留
	backend.onEvent((sessionId, event) => {
		sendToRenderer(IpcChannels.Event, { sessionId, event });
	});
	forward(backend.onPermissionRequest.bind(backend), IpcChannels.PermissionRequest);
	// 权限裁决也回投渲染端：LAN 远程应答 / 其他来源应答时桌面卡片要同步撤掉
	forward(backend.onPermissionResolved.bind(backend), IpcChannels.PermissionResolved);
	forward(backend.onTrustRequest.bind(backend), IpcChannels.TrustRequest);
	// 扩展对话框四事件：请求/结算/notify/草稿预填（issue #45）
	forward(backend.onExtensionDialogRequest.bind(backend), IpcChannels.ExtensionDialogRequest);
	forward(backend.onExtensionDialogResolved.bind(backend), IpcChannels.ExtensionDialogResolved);
	// 内置问卷两事件：请求/结算（与扩展对话框平行的专用卡）
	forward(backend.onAskUserRequest.bind(backend), IpcChannels.AskUserRequest);
	forward(backend.onAskUserResolved.bind(backend), IpcChannels.AskUserResolved);
	forward(backend.onExtensionNotify.bind(backend), IpcChannels.ExtensionNotify);
	forward(backend.onExtensionEditorText.bind(backend), IpcChannels.ExtensionEditorText);
	forward(backend.onLoginEvent.bind(backend), IpcChannels.SettingsLoginEvent);
	forward(backend.onMcpServersChanged.bind(backend), IpcChannels.McpServersChanged);
	// 频道订阅快照变化（spec D1）：payload 自带 generation+revision，renderer 自行判新旧
	forward(backend.onChannelSubscriptionsChanged.bind(backend), IpcChannels.ChannelSubscriptionsChanged);
	forward(onUpdateState, IpcChannels.UpdateEvent);
}
