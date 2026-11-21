import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/drop-rail.css";
import { App } from "./App";
import { appVersion, detectPlatform, installErrorLogging } from "./lib/bridge";
import { logger } from "./lib/log";

// Uncaught errors and unhandled rejections go to the desktop log (no-op outside the desktop app).
installErrorLogging();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// After the first paint: how long the window took to show something.
requestAnimationFrame(() =>
  logger.info("app", `ui ready v${appVersion()} ${detectPlatform()} in ${Math.round(performance.now())} ms, ${window.innerWidth}x${window.innerHeight}`),
);
