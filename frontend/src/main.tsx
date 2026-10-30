import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeTheme } from "./theme";
import "./styles.css";

async function start() {
  if (import.meta.env.MODE === "demo") await (await import("../demo/browser")).startDemo();
  initializeTheme();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
