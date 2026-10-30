import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

function showBadge() {
  const badge = document.createElement("div");
  badge.textContent = "在线预览 · 数据均为模拟，刷新页面即重置";
  Object.assign(badge.style, {
    position: "fixed", left: "50%", bottom: "8px", transform: "translateX(-50%)", zIndex: "2147483647",
    padding: "3px 10px", borderRadius: "999px", font: "12px/1.6 system-ui, sans-serif",
    color: "#fff", background: "rgba(17, 20, 18, 0.72)", pointerEvents: "none",
  });
  document.body.append(badge);
}

export async function startDemo() {
  await setupWorker(...handlers).start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: "bypass",
    quiet: true,
  });
  showBadge();
}
