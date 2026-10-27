import type { ComponentType, CSSProperties } from "react";
import { useRef } from "react";
import { useT } from "../../i18n";
import { useEdgeFade } from "../../lib/use-edge-fade";
import { type SettingsCategory, useSettingsStore } from "../../stores/settings";
import { AboutPanel } from "./AboutPanel";
import { AppearancePanel } from "./AppearancePanel";
import { ArchivePanel } from "./ArchivePanel";
import { ExtensionsPanel } from "./extensions/ExtensionsPanel";
import { GeneralPanel } from "./GeneralPanel";
import { LanObserverPanel } from "./LanObserverPanel";
import { McpPanel } from "./mcp/McpPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";
import { SkillsPanel } from "./SkillsPanel";

const STATIC_CATEGORIES = [
	"general",
	"appearance",
	"models",
	"skills",
	"mcp",
	"extensions",
	"archive",
	"lan",
	"about",
] as const satisfies readonly SettingsCategory[];

/** 面板注册表：新增分类 = 写一个面板组件 + 在这里登记（未登记显示 coming soon） */
const PANELS: Partial<Record<SettingsCategory, ComponentType>> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	models: ProvidersPanel,
	skills: SkillsPanel,
	mcp: McpPanel,
	extensions: ExtensionsPanel,
	archive: ArchivePanel,
	lan: LanObserverPanel,
	about: AboutPanel,
};

/** 设置弹窗：只在打开时挂载（弹窗体里的滚动容器需要在挂载时就能拿到 ref —— useEdgeFade 不会因
    元素后出现而重跑） */
export function SettingsDialog() {
	const open = useSettingsStore((s) => s.open);
	if (!open) return null;
	return <SettingsDialogBody />;
}

/** 弹窗体：左侧分类导航 + 右侧内容，两列均可独立滚动 */
function SettingsDialogBody() {
	const t = useT();
	const setOpen = useSettingsStore((s) => s.setOpen);
	const category = useSettingsStore((s) => s.category);
	const setCategory = useSettingsStore((s) => s.setCategory);

	// 两列各自是滚动容器：分割线只留左导航右缘那条（`.fade-rule-v`），内容区的边界改由滚动淡出表达
	const navRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	useEdgeFade(navRef);
	useEdgeFade(contentRef);

	const Panel = PANELS[category];

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center" role="dialog" aria-modal>
			<div className="flex h-[70vh] w-[60vw] flex-col overflow-hidden rounded-xl bg-surface shadow-dialog">
				{/* 顶栏底边不画 1px 实线（与对话页顶栏同一决策）：下面的内容滚动时用边界淡出区分 */}
				<div className="flex shrink-0 items-center justify-between px-4 py-3">
					<h2 className="text-ui-14 leading-[calc(1.25_/_0.875)] font-semibold text-ink">
						{t("settings.title")}
					</h2>
					<button
						type="button"
						className="rounded-lg px-2 py-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					{/* 与内容的分界：中段实、两头淡出的发丝线（`.fade-rule-v`，同左栏） */}
					<nav
						ref={navRef}
						className="fade-rule-v edge-fade w-44 shrink-0 overflow-y-auto p-2"
						style={{ "--edge-fade-size": "16px" } as CSSProperties}
					>
						{STATIC_CATEGORIES.map((id) => (
							<button
								key={id}
								type="button"
								className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
									category === id
										? "bg-hover font-medium text-ink"
										: "text-ink-dim hover:bg-hover hover:text-ink"
								}`}
								onClick={() => setCategory(id)}
							>
								{t(`settings.category.${id}`)}
							</button>
						))}
					</nav>
					<div
						ref={contentRef}
						className="edge-fade min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
						style={{ "--edge-fade-size": "20px" } as CSSProperties}
					>
						{Panel ? (
							<Panel />
						) : (
							<p className="py-8 text-center text-ui-13 text-ink-faint">{t("settings.comingSoon")}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
