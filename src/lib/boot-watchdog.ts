/** Inline boot watchdog: recovers when the hashed client bundle 404s and React never starts. */

export const BOOT_READY_FLAG = "__CB_CLIENT_READY";
export const REACT_MOUNTED_FLAG = "__CB_REACT_MOUNTED";
export const BOOT_WATCHDOG_MS = 8_000;
/** Signed-in SSR boot ("Loading your projects…") must not last forever if React/hydrate stall. */
export const BOOT_STUCK_MS = 12_000;
export const LOGIN_LOG_FLAG = "__CB_LOGIN_LOG";
export const SKIP_HYDRATE_KEY = "cb-skip-hydrate";
/** One auto-reload after a hashed /assets/ script load fail (deploy skew or HTML-as-JS cache). */
export const ASSET_RELOAD_KEY = "cb-asset-reload";

/** Parse-time ready signal so a rendered shell does not wait on React useEffect. */
export const BOOT_READY_SCRIPT = `window.${BOOT_READY_FLAG}=true`;

export function scriptErrorAction(src: string, alreadyReloaded: boolean): "reload" | "show" | "note" {
  if (!src || src.indexOf("/assets/") === -1) return "note";
  return alreadyReloaded ? "show" : "reload";
}

/** HttpOnly session cookies are invisible to document.cookie. Baked SSR user still counts. */
export function loginSessionPresent(baked: boolean, jsCookie: boolean): boolean {
  return Boolean(baked || jsCookie);
}

/**
 * A rendered data-cb-shell (guest / app / boot / error) means SSR produced UI.
 * The overlay is only for a blank document where React never started.
 * A boot shell that is still boot after BOOT_STUCK_MS is a hydrate stall: offer Retry.
 * Sign out clears the session so /login does not auto-land back into boot.
 * Login log is vanilla DOM so it still works when React never mounts.
 */
export const BOOT_WATCHDOG_INLINE = `(function(){var F="${BOOT_READY_FLAG}",R="${REACT_MOUNTED_FLAG}",M=${BOOT_WATCHDOG_MS},S=${BOOT_STUCK_MS},L="${LOGIN_LOG_FLAG}",A="${ASSET_RELOAD_KEY}";function note(m){try{window[L]=window[L]||[];window[L].push(String(m).slice(0,180));window[L]=window[L].slice(-40)}catch(e){}}function ok(){if(window[F])return true;try{return Boolean(document.querySelector('[data-cb-shell],a[href*="/api/oauth-start/"]'))}catch(e){return false}}function mark(){if(ok())window[F]=true}function brief(){var lines=["stage: boot-stuck"];try{lines.push("react: "+(window[R]?"1":"0"));lines.push("ready: "+(window[F]?"1":"0"));var sh=document.querySelector("[data-cb-shell]");lines.push("shell: "+(sh&&sh.getAttribute("data-cb-shell")||"none"));var baked=window.__CB_SSR_SESSION&&window.__CB_SSR_SESSION.id;var jsCookie=/(?:__Host-)?grok-auth\\.session_token=/.test(document.cookie);lines.push("session: "+(baked||jsCookie?"1":"0"));lines.push("baked: "+(baked?"1":"0"));lines.push("iframe: "+(window.self!==window.top?"1":"0"));lines.push("cookie: "+(jsCookie?"1":"0"));try{lines.push("path: "+location.pathname)}catch(x){}var log=window[L]||[];for(var i=Math.max(0,log.length-12);i<log.length;i++)lines.push(String(log[i]).slice(0,180))}catch(e){lines.push("log-error")}return lines.join("\\n")}function fillLog(root){var pre=root&&root.querySelector?root.querySelector("#cb-login-log-body"):null;if(!pre)pre=document.getElementById("cb-login-log-body");if(pre)pre.textContent=brief()}function show(){mark();if(ok())return;if(document.getElementById("cb-boot-fail"))return;var el=document.createElement("div");el.id="cb-boot-fail";el.setAttribute("role","alert");el.style.cssText="position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0c0c0d;color:#f1f1ef;padding:24px;text-align:center;font-family:ui-sans-serif,system-ui,sans-serif";el.innerHTML='<p style="max-width:28rem;line-height:1.5;margin:0">The app did not finish loading. Reload this page.</p><button type="button" style="min-height:44px;padding:0 18px;border:0;border-radius:4px;background:#d7d4cc;color:#0c0c0d;font-weight:600;cursor:pointer">Reload</button>';var b=el.querySelector("button");if(b)b.onclick=function(){location.reload()};document.body.appendChild(el)}function signOutNow(){note("sign-out");try{sessionStorage.removeItem("${SKIP_HYDRATE_KEY}");sessionStorage.removeItem("grok-auth.bearer-token");sessionStorage.removeItem("grok-auth.returning")}catch(e){}var go=function(){location.href="/login?stay=1"};try{fetch("/api/auth/sign-out",{method:"POST",credentials:"include"}).catch(function(){}).then(go)}catch(e){go()}}function logBox(){return '<details id="cb-login-log" style="width:100%;text-align:left;border:1px solid #3a3a3c;border-radius:8px;background:#141416"><summary style="min-height:44px;cursor:pointer;padding:8px 12px;color:#f1f1ef;font-weight:600">Login log</summary><pre id="cb-login-log-body" style="margin:0;padding:8px 12px;max-height:10rem;overflow:auto;white-space:pre-wrap;color:#9a9a94;font:12px/1.4 ui-monospace,Menlo,monospace"></pre></details>'}function stuck(){mark();var boot;try{boot=document.querySelector('[data-cb-shell="boot"]')}catch(e){return}if(!boot)return;try{if(document.querySelector('[data-cb-shell="app"],[data-cb-shell="guest"],[data-cb-shell="error"]'))return}catch(e){return}if(document.getElementById("cb-boot-stuck")||document.getElementById("cb-boot-fail"))return;note("boot-stuck");boot.setAttribute("data-cb-shell","error");var hasLog=Boolean(document.getElementById("cb-login-log"));var box=document.createElement("div");box.id="cb-boot-stuck";box.setAttribute("role","alert");box.style.cssText="display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:16px;text-align:center;font-family:ui-sans-serif,system-ui,sans-serif;width:min(28rem,100%)";box.innerHTML='<p style="max-width:28rem;line-height:1.5;margin:0;color:#f1f1ef">Loading projects timed out. Retry, open anyway, or sign out.</p><button type="button" data-cb="retry" style="min-height:44px;padding:0 18px;border:0;border-radius:4px;background:#d7d4cc;color:#0c0c0d;font-weight:600;cursor:pointer">Retry</button><button type="button" data-cb="skip" style="min-height:44px;padding:0 18px;border:1px solid #3a3a3c;border-radius:4px;background:transparent;color:#f1f1ef;font-weight:600;cursor:pointer">Open workspace anyway</button><button type="button" data-cb="out" style="min-height:44px;padding:0 18px;border:1px solid #3a3a3c;border-radius:4px;background:transparent;color:#f1f1ef;font-weight:600;cursor:pointer">Sign out</button>'+(hasLog?"":logBox());var r=box.querySelector('[data-cb="retry"]');var k=box.querySelector('[data-cb="skip"]');var o=box.querySelector('[data-cb="out"]');if(r)r.onclick=function(){location.reload()};if(k)k.onclick=function(){try{sessionStorage.setItem("${SKIP_HYDRATE_KEY}","1")}catch(e){}location.reload()};if(o)o.onclick=signOutNow;boot.appendChild(box);fillLog(box)}function assetReload(src){note("script: "+src);try{if(sessionStorage.getItem(A)==="1"){note("script-reload: skip");show();return}sessionStorage.setItem(A,"1");note("script-reload: 1");location.reload()}catch(e){show()}}function hookConsole(){try{var c=console.error;console.error=function(){try{var s=Array.prototype.join.call(arguments," ");if(/Minified React error|Hydration|#418|#419|#422|#423|#425/i.test(s))note("react: "+String(s).slice(0,160))}catch(x){}return c.apply(console,arguments)}}catch(e){}}function hookFetch(){try{var of=window.fetch;if(typeof of!=="function")return;window.fetch=function(){var args=arguments;var u=args[0];var url=typeof u==="string"?u:(u&&u.url)||"";var short=String(url).slice(0,100);return of.apply(this,args).then(function(res){try{if(short.indexOf("/api/auth/")!==-1||(res&&!res.ok&&/post/i.test(String((u&&u.method)||(args[1]&&args[1].method)||""))))note("http: "+(res&&res.status)+" "+short)}catch(x){}return res},function(err){note("fetch-fail: "+short);throw err})}}catch(e){}}hookConsole();hookFetch();if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mark);else mark();window.addEventListener("error",function(e){var t=e&&e.target;var msg=e&&e.message?String(e.message):"";if(t&&t.tagName==="SCRIPT"&&t.src&&t.src.indexOf("/assets/")!==-1){assetReload(t.src)}else if(msg)note("error: "+msg.slice(0,160))},true);window.addEventListener("unhandledrejection",function(e){try{note("reject: "+String(e&&e.reason&&e.reason.message||e.reason).slice(0,160))}catch(x){}});setTimeout(show,M);setTimeout(stuck,S)})();`;

export function markClientReady(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & { [BOOT_READY_FLAG]?: boolean; [REACT_MOUNTED_FLAG]?: boolean };
  w[BOOT_READY_FLAG] = true;
  w[REACT_MOUNTED_FLAG] = true;
  document.getElementById("cb-boot-fail")?.remove();
  try {
    window.sessionStorage.removeItem(ASSET_RELOAD_KEY);
  } catch {
    /* ignore */
  }
}

export function readSkipHydrate(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SKIP_HYDRATE_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSkipHydrate(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SKIP_HYDRATE_KEY);
  } catch {
    /* ignore */
  }
}
