/**
 * StockSage mobile entry point.
 *
 * The shared React pages (frontend/src) talk to "/api/*" through the shared
 * axios client; here that client's adapter is swapped for the in-process
 * backend, so every call is answered on the phone. Two modes:
 *   normal         the UI
 *   ?job=MORNING   headless background run started by the Android scheduler
 */
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/sora/400.css";
import "@fontsource/sora/600.css";
import "@fontsource/sora/700.css";
import "@fontsource/sora/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@app/index.css";
import "./mobile.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { api } from "@app/api/client";
import { initBackend, localAdapter, runScheduledJob, type JobType } from "./backend";
import { androidPlatform } from "./native/androidPlatform";
import { native } from "./native/bridge";
import { installDeviceHooks } from "./native/hooks";
import MobileApp from "./MobileApp";

const job = new URLSearchParams(location.search).get("job") as JobType | null;
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (!native) {
  root.render(
    <div style={{ padding: 32, fontFamily: "Inter, sans-serif", color: "#e9f0ff", background: "#090c16", minHeight: "100vh" }}>
      <h2>StockSage runs inside its Android app.</h2>
      <p>This bundle needs the native bridge for storage and market data. Build it with <code>mobile/build.ps1</code>.</p>
    </div>);
} else {
  initBackend(androidPlatform(native));
  // The shared sources resolve axios' types from frontend/node_modules; same runtime object.
  api.defaults.adapter = localAdapter as any;

  if (job) {
    runScheduledJob(job)
      .then((outcome) => native!.jobFinished(JSON.stringify(outcome)))
      .catch((e) => native!.jobFinished(JSON.stringify({ ok: false, title: "StockSage run failed", body: String(e?.message ?? e) })));
  } else {
    installDeviceHooks();
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <MobileApp />
        </BrowserRouter>
      </React.StrictMode>,
    );
  }
}
