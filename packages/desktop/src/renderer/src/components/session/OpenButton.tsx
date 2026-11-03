import type { OpenToolId } from "@percho/shared";
import { useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { useSessionsStore } from "../../stores/sessions";
import { useToastsStore } from "../../stores/toasts";
import { ChevronDownIcon, FolderOpenIcon } from "../icons";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";

/** 菜单项文案（文件管理器按平台叫资源管理器 / 访达 / 文件管理器） */
function toolLabel(t: ReturnType<typeof useT>, id: OpenToolId): string {
	switch (id) {
		case "fileManager":
			return getPi().platform === "darwin"
				? t("openWith.finder")
				: getPi().platform === "win32"
					? t("openWith.explorer")
					: t("openWith.fileManager");
		case "vscode":
			return t("openWith.vscode");
		case "gitBash":
			return t("openWith.gitBash");
		case "terminal":
			return t("openWith.terminal");
	}
}

/** 顶栏「打开」（变更按钮之后）：主体一键进文件管理器；小箭头列全部检测到的打开方式。
 *  无项目目录（cwd 为 null）不渲染——没有可打开的根目录 */
export function OpenButton() {
	const t = useT();
	const cwd = useSessionsStore(selectActiveCwd);
	const [menu, setMenu] = useState<{ anchor: MenuAnchor; tools: OpenToolId[] } | null>(null);

	if (!cwd) return null;

	const openWith = (tool: OpenToolId) => {
		getPi()
			.openWith({ cwd, tool })
			.catch((error: unknown) => {
				useToastsStore
					.getState()
					.push("error", "openWith.openFailed", error instanceof Error ? error.message : String(error));
			});
	};

	const openMenu = (anchor: MenuAnchor) => {
		getPi()
			.listOpenTools()
			.then((tools) => setMenu({ anchor, tools }))
			.catch(() => useToastsStore.getState().push("error", "openWith.detectFailed"));
	};

	const items: ContextMenuItem[] =
		menu?.tools.map((id) => ({ key: id, label: toolLabel(t, id), onSelect: () => openWith(id) })) ?? [];

	return (
		<>
			<div className="no-drag flex shrink-0 items-center rounded-lg text-ink-dim transition-colors hover:bg-ink/10 hover:text-ink">
				<button
					type="button"
					className="p-1.5"
					aria-label={t("openWith.open")}
					onClick={() => openWith("fileManager")}
				>
					<FolderOpenIcon size={16} />
				</button>
				<button
					type="button"
					className="py-1.5 pr-1.5"
					aria-label={t("openWith.more")}
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						openMenu({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
					}}
				>
					<ChevronDownIcon size={10} />
				</button>
			</div>
			{menu && <ContextMenu anchor={menu.anchor} items={items} onClose={() => setMenu(null)} />}
		</>
	);
}
