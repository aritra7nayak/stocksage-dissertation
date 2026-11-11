import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const shared = resolve(here, "../../frontend/src");

/**
 * The shared pages' error copy assumes a FastAPI server ("is the backend
 * running on port 8000?"). On the phone there is no server, so the mobile
 * build rewrites those messages; the web app keeps its own wording.
 */
const COPY: [RegExp, string][] = [
  [/Couldn't reach the engine\. Is the backend running on port 8000\?/g, "Couldn't build today's brief. Check your internet connection, then pull down to retry."],
  [/ Is the backend running on port 8000\?/g, " Check your internet connection and try again."],
  [/Engine run failed — check the backend logs\./g, "Engine run failed — check your internet connection and try again."],
  [/That run was lost when the backend restarted — start a new one\./g, "That run was lost when the app was closed — start a new one."],
  [/Lost contact with the backend\. Is it still running\?/g, "Lost track of that run — start it again."],
  [/Lost contact with the backend\./g, "Lost track of that run — start it again."],
  [/ — is the backend running\?/g, " — check your internet connection."],
  [/The backend may be busy or the symbol unavailable\./g, "Check your connection — or the symbol may be unavailable."],
  [/The backend may be busy or NSE unreachable\./g, "NSE or Yahoo may be unreachable right now."],
];

function phoneCopy(): Plugin {
  return {
    name: "stocksage-phone-copy",
    enforce: "pre",
    transform(code, id) {
      const norm = (p: string) => p.split("\\").join("/");
      if (!norm(id).startsWith(norm(shared))) return null;
      let out = code;
      for (const [re, to] of COPY) out = out.replace(re, to);
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default defineConfig({
  plugins: [phoneCopy(), react()],
  resolve: {
    alias: { "@app": shared },
    // Shared sources live outside this package: make them use OUR copies.
    dedupe: ["react", "react-dom", "react-router-dom", "framer-motion", "zustand", "axios", "recharts", "lucide-react"],
  },
  server: { fs: { allow: [resolve(here, "../..")] } },
  build: {
    outDir: resolve(here, "../android/app/src/main/assets/web"),
    emptyOutDir: true,
    target: "chrome100",
    chunkSizeWarningLimit: 2500,
    assetsInlineLimit: 0,
  },
});
