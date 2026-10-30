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

function showInsecureNotice() {
  const notice = document.createElement("p");
  notice.textContent = "在线预览需要通过 HTTPS 访问：浏览器只在安全连接下启用模拟后端所需的 Service Worker。";
  Object.assign(notice.style, { maxWidth: "36em", margin: "20vh auto", padding: "0 24px", font: "15px/1.7 system-ui, sans-serif" });
  document.getElementById("root")?.replaceChildren(notice);
}

/** Returns false when the page cannot host the mock backend, so the app must not start. */
export async function startDemo(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    showInsecureNotice();
    return false;
  }
  await setupWorker(...handlers).start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: "bypass",
    quiet: true,
  });
  showBadge();
  return true;
}
