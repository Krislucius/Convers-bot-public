import { FormEvent, useEffect, useState } from "react";
import { AuthReportPanel } from "@/components/auth-report-panel";
import { Field, PrimaryButton, TextInput } from "@/components/council-ui";
import { GROK_PROVIDERS, authClient, authEnabled, signIn, signOut } from "@/lib/auth/client";
import { emailAndPasswordEnabled } from "@/lib/auth/email-password";
import { captureSessionToken, markAuthReturning, shouldPopupOAuth, waitForAuthPopup, withDeadline, GET_SESSION_WAIT_MS } from "@/lib/auth-loop";

const OAUTH_BTN =
  "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-sm border border-accent bg-accent px-3.5 py-2.5 font-semibold text-accent-fg no-underline";

function inLivePreview(): boolean {
  return typeof window !== "undefined" && window.location.hostname.endsWith(".grok-sandbox.com");
}

export const ERROR_COPY: Record<string, string> = {
  oauth: "Google or X sign-in did not finish. Try again.",
  "oauth-init": "Could not start Google/X sign-in. Try again.",
  "oauth-url": "Could not start Google/X sign-in. Try again.",
  "unknown-provider": "That sign-in method is not available.",
  "signin-timeout": "Sign-in timed out. Try again.",
  "signin-failed": "Sign-in failed. Try again.",
};

export function StaySignedIn() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-3">
      <p className="m-0 text-sm text-muted">You are already signed in. Open the app instead of bouncing back through Sign in.</p>
      <a
        href="/"
        className={OAUTH_BTN}
        style={{ background: "#d7d4cc", color: "#0c0c0d", textDecoration: "none" }}
      >
        Continue to projects
      </a>
      <button
        type="button"
        className="inline-flex min-h-11 items-center justify-center rounded-sm border border-line px-3.5 font-semibold"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signOut("/login").catch(() => setBusy(false));
        }}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      <AuthReportPanel extra={{ page: "stay-signed-in" }} />
    </div>
  );
}

export function LoginForm({
  searchError,
  onSignedIn,
}: {
  searchError?: string;
  onSignedIn?: () => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [popupAuth, setPopupAuth] = useState(false);

  useEffect(() => {
    setPopupAuth(shouldPopupOAuth());
  }, []);

  async function onOAuth(providerId: string) {
    setError("");
    setBusy(true);
    markAuthReturning();
    try {
      await signIn(providerId, { callbackURL: "/", errorCallbackURL: "/login?error=oauth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  function startPopup(providerId: string) {
    markAuthReturning();
    if (inLivePreview()) {
      void onOAuth(providerId);
      return;
    }
    const popup = window.open(
      `/api/oauth-start/${providerId}`,
      `grok-signin-${Date.now()}`,
      "popup,width=500,height=650",
    );
    void onFramedOAuth(popup);
  }

  async function onFramedOAuth(popup: Window | null) {
    setError("");
    setBusy(true);
    markAuthReturning();
    if (!popup) {
      setError("Pop-up blocked — allow pop-ups for sign-in");
      setBusy(false);
      return;
    }
    try {
      const token = await waitForAuthPopup(popup);
      if (!token) throw new Error("Sign-in was cancelled or failed");
      captureSessionToken({ token });
      try {
        await withDeadline(authClient.getSession(), GET_SESSION_WAIT_MS, "signin-timeout");
      } catch {
        /* bearer is stored; useSession will catch up or expire to guest */
      }
      onSignedIn?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  async function onEmail(e: FormEvent) {
    e.preventDefault();
    if (!emailAndPasswordEnabled) return;
    setError("");
    setBusy(true);
    markAuthReturning();
    try {
      if (mode === "signup") {
        const result = await authClient.signUp.email({
          email: email.trim(),
          password,
          name: name.trim() || email.trim().split("@")[0] || "Operator",
        });
        if (result.error) throw new Error(result.error.message || "Could not create the account.");
        captureSessionToken(result);
      } else {
        const result = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        if (result.error) throw new Error(result.error.message || "Could not sign in.");
        captureSessionToken(result);
      }
      try {
        await withDeadline(authClient.getSession(), GET_SESSION_WAIT_MS, "signin-timeout");
      } catch {
        /* land with the captured token even if get-session is slow */
      }
      onSignedIn?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  const shownError = error || (searchError ? ERROR_COPY[searchError] || "Sign-in failed. Try again." : "");

  if (!authEnabled) {
    return <p className="text-muted">Sign-in is disabled.</p>;
  }

  return (
    <div className="grid gap-3">
      {GROK_PROVIDERS.map((provider) =>
        popupAuth ? (
          <button
            key={provider.providerId}
            type="button"
            className={OAUTH_BTN}
            style={{ background: "#d7d4cc", color: "#0c0c0d" }}
            disabled={busy}
            onClick={() => startPopup(provider.providerId)}
          >
            Continue with {provider.label}
          </button>
        ) : (
          <a
            key={provider.providerId}
            href={`/api/oauth-start/${provider.providerId}`}
            className={OAUTH_BTN}
            style={{ background: "#d7d4cc", color: "#0c0c0d" }}
            onClick={(e) => {
              if (shouldPopupOAuth()) {
                e.preventDefault();
                e.stopPropagation();
                startPopup(provider.providerId);
                return;
              }
              markAuthReturning();
              setBusy(true);
            }}
          >
            Continue with {provider.label}
          </a>
        ),
      )}
      {emailAndPasswordEnabled ? (
        <>
          <p className="mt-2 mb-0 text-sm text-faint">Or use email</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`min-h-11 rounded-sm px-3.5 font-semibold ${
                mode === "signin"
                  ? "border border-accent bg-accent text-accent-fg"
                  : "border border-line bg-transparent text-fg"
              }`}
              onClick={() => setMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`min-h-11 rounded-sm px-3.5 font-semibold ${
                mode === "signup"
                  ? "border border-accent bg-accent text-accent-fg"
                  : "border border-line bg-transparent text-fg"
              }`}
              onClick={() => setMode("signup")}
            >
              Create account
            </button>
          </div>
          <form className="grid gap-3" onSubmit={(e) => void onEmail(e)}>
            {mode === "signup" ? (
              <Field label="Name">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </Field>
            ) : null}
            <Field label="Email">
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </Field>
            <Field label="Password">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </Field>
            <PrimaryButton type="submit" disabled={busy}>
              {busy ? "Signing in…" : mode === "signup" ? "Create account" : "Sign in with email"}
            </PrimaryButton>
          </form>
        </>
      ) : null}
      {shownError ? <p className="m-0 text-sm text-danger">{shownError}</p> : null}
      <AuthReportPanel extra={{ page: "login-form" }} />
    </div>
  );
}
