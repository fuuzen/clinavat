import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeTheme } from "./theme";
import DetachedWindowRoot from "./windows/DetachedWindowRoot";
import { parseDetachedWindowFromSearch } from "./windows/types";
import "./styles.css";

async function start() {
  if (import.meta.env.MODE === "demo" && !(await (await import("../demo/browser")).startDemo())) return;
  initializeTheme();
  const detachedTarget = parseDetachedWindowFromSearch(window.location.search);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {detachedTarget ? <DetachedWindowRoot target={detachedTarget} /> : <App />}
    </StrictMode>,
  );
}

void start();
