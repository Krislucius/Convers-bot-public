/** Inline boot watchdog: recovers when the hashed client bundle 404s and React never starts. */

export const BOOT_READY_FLAG = "__CB_CLIENT_READY";
export const BOOT_WATCHDOG_MS = 8_000;
/** Signed-in SSR boot ("Loading your projects…") must not last forever if React/hydrate stall. */
export const BOOT_STUCK_MS = 12_000;

/** Parse-time ready signal so a rendered shell does not wait on React useEffect. */
export const BOOT_READY_SCRIPT = `window.${BOOT_READY_FLAG}=true`;

/**
 * A rendered data-cb-shell (guest / app / boot / error) means SSR produced UI.
 * The overlay is only for a blank document where React never started.
 * A boot shell that is still boot after BOOT_STUCK_MS is a hydrate stall: offer Retry.
 */
export const BOOT_WATCHDOG_INLINE = `(function(){var F="${BOOT_READY_FLAG}",M=${BOOT_WATCHDOG_MS},S=${BOOT_STUCK_MS};function ok(){if(window[F])return true;try{return Boolean(document.querySelector('[data-cb-shell],a[href*="/api/oauth-start/"]'))}catch(e){return false}}function mark(){if(ok())window[F]=true}function show(){mark();if(ok())return;if(document.getElementById("cb-boot-fail"))return;var el=document.createElement("div");el.id="cb-boot-fail";el.setAttribute("role","alert");el.style.cssText="position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0c0c0d;color:#f1f1ef;padding:24px;text-align:center;font-family:ui-sans-serif,system-ui,sans-serif";el.innerHTML='<p style="max-width:28rem;line-height:1.5;margin:0">The app did not finish loading. Reload this page.</p><button type="button" style="min-height:44px;padding:0 18px;border:0;border-radius:4px;background:#d7d4cc;color:#0c0c0d;font-weight:600;cursor:pointer">Reload</button>';var b=el.querySelector("button");if(b)b.onclick=function(){location.reload()};document.body.appendChild(el)}function stuck(){mark();var boot;try{boot=document.querySelector('[data-cb-shell="boot"]')}catch(e){return}if(!boot)return;try{if(document.querySelector('[data-cb-shell="app"],[data-cb-shell="guest"],[data-cb-shell="error"]'))return}catch(e){return}if(document.getElementById("cb-boot-stuck")||document.getElementById("cb-boot-fail"))return;boot.setAttribute("data-cb-shell","error");var box=document.createElement("div");box.id="cb-boot-stuck";box.setAttribute("role","alert");box.style.cssText="display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:16px;text-align:center;font-family:ui-sans-serif,system-ui,sans-serif";box.innerHTML='<p style="max-width:28rem;line-height:1.5;margin:0;color:#f1f1ef">Loading projects timed out. Retry or sign in again.</p><button type="button" data-cb="retry" style="min-height:44px;padding:0 18px;border:0;border-radius:4px;background:#d7d4cc;color:#0c0c0d;font-weight:600;cursor:pointer">Retry</button><button type="button" data-cb="out" style="min-height:44px;padding:0 18px;border:1px solid #3a3a3c;border-radius:4px;background:transparent;color:#f1f1ef;font-weight:600;cursor:pointer">Sign in again</button>';var r=box.querySelector('[data-cb="retry"]');var o=box.querySelector('[data-cb="out"]');if(r)r.onclick=function(){location.reload()};if(o)o.onclick=function(){location.href="/login"};boot.appendChild(box)}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mark);else mark();window.addEventListener("error",function(e){var t=e&&e.target;if(t&&t.tagName==="SCRIPT"&&t.src&&t.src.indexOf("/assets/")!==-1)show()},true);setTimeout(show,M);setTimeout(stuck,S)})();`;

export function markClientReady(): void {
  if (typeof window === "undefined") return;
  (window as Window & { [BOOT_READY_FLAG]?: boolean })[BOOT_READY_FLAG] = true;
  document.getElementById("cb-boot-fail")?.remove();
}
