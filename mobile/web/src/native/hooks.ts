/**
 * Glue between web conventions and the phone:
 *  - external links open in the system browser, not inside the app
 *  - <a download href="blob:..."> (the Excel export) saves to Downloads
 *  - insets from the native window land in CSS variables
 *  - the theme drives the status-bar icon colour
 */
import { callAsync, native } from "./bridge";
import { toast } from "../ui/toast";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function saveBlobUrl(href: string, name: string) {
  try {
    const blob = await (await fetch(href)).blob();
    const b64 = await blobToBase64(blob);
    const r = await callAsync<{ path: string }>((id) => native!.saveFile(id, name, blob.type || "application/octet-stream", b64));
    toast(`Saved to ${r.path}`, "success");
  } catch (e) {
    toast(`Couldn't save the file: ${(e as Error).message}`, "error");
  }
}

export function installDeviceHooks(): void {
  if (!native) return;

  // Downloads: the shared code builds a blob URL and clicks a hidden anchor.
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.href.startsWith("blob:") && this.download) {
      void saveBlobUrl(this.href, this.download);
      return;
    }
    origClick.call(this);
  };

  // External links → system browser
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (!a || !a.href) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin && /^https?:$/.test(url.protocol)) {
      e.preventDefault();
      native!.openExternal(url.toString());
    }
  }, true);

  // Window insets (status bar, nav bar, keyboard) pushed by MainActivity
  window.__ssNative = {
    ...(window.__ssNative as any),
    insets(t: number, r: number, b: number, l: number) {
      const s = document.documentElement.style;
      s.setProperty("--sat", `${t}px`);
      s.setProperty("--sar", `${r}px`);
      s.setProperty("--sab", `${b}px`);
      s.setProperty("--sal", `${l}px`);
    },
  };

  // Status-bar icons follow the resolved theme
  const sync = () => native!.setSystemBars(document.documentElement.classList.contains("dark"));
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  sync();
}
