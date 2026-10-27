import { useEffect, useState } from "react";

const MEDIA = "(prefers-reduced-motion: reduce)";

/**
 * 系统「减少动态」偏好的查询（各视觉效果开关在调用点与 ui-preferences 的分项设置求并）。
 * 性能细化开关见 ui-preferences（streamingMarquee/pageSlide/orbAnimation/uiTransitions）。
 */

/** 非组件语境（命令式路径，如 withSessionSlide）：即时读取 */
export function systemReducedMotion(): boolean {
	return window.matchMedia(MEDIA).matches;
}

/** 组件语境：订阅系统偏好变化 */
export function useSystemReducedMotion(): boolean {
	const [system, setSystem] = useState(() => window.matchMedia(MEDIA).matches);
	useEffect(() => {
		const media = window.matchMedia(MEDIA);
		const update = () => setSystem(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	return system;
}
