import { useEffect, useState } from "react";
import { useUiPreferencesStore } from "../stores/ui-preferences";

const MEDIA = "(prefers-reduced-motion: reduce)";

/**
 * 动效开关的唯一判定源：性能模式（设置项）∪ 系统减少动态偏好。
 * 性能模式开启时全部非必要视觉动效降级为静态（各动效点统一走这里，不各自 matchMedia）。
 */

/** 非组件语境（命令式路径，如 withSessionSlide）：即时读取 */
export function motionReduced(): boolean {
	if (useUiPreferencesStore.getState().performanceMode) return true;
	return window.matchMedia(MEDIA).matches;
}

/** 组件语境：双源订阅，任一变化即重渲染 */
export function useMotionReduced(): boolean {
	const perf = useUiPreferencesStore((s) => s.performanceMode);
	const [system, setSystem] = useState(() => window.matchMedia(MEDIA).matches);
	useEffect(() => {
		const media = window.matchMedia(MEDIA);
		const update = () => setSystem(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	return perf || system;
}
