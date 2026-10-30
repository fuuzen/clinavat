import { useEffect, useState, type FormEvent, type InvalidEvent } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import { errorText, post } from "../../api";
import type { SiteSettings } from "../../site/settings";
import { interpolate, RichContent } from "./content";

export type AuthMode = "login" | "register" | "setup";

interface Props {
  settings: SiteSettings;
  mode: AuthMode;
  registrationEnabled: boolean;
  preview: boolean;
  onModeChange: (mode: AuthMode) => void;
  onAuthenticated: () => Promise<void>;
}

export default function AuthForm({ settings, mode, registrationEnabled, preview, onModeChange, onAuthenticated }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const texts = settings.login.texts;
  const creating = mode !== "login";
  const text = (source: string) => interpolate(source, settings);
  useEffect(() => { setError(""); }, [mode]);

  function invalid(event: InvalidEvent<HTMLInputElement>, message: string) {
    const input = event.currentTarget;
    input.setCustomValidity("");
    const configuredMessage = text(input.validity.valueMissing ? texts.requiredValidation : message);
    input.setCustomValidity(configuredMessage);
    if (!configuredMessage) event.preventDefault();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (preview || busy) return;
    setBusy(true);
    setError("");
    try {
      await post(`/auth/${mode}`, { username, password });
      await onAuthenticated();
    } catch (cause) {
      setError(text(texts[`${mode}Error`]).replaceAll("{{error}}", errorText(cause)));
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-form-wrap">
    {texts.formEyebrow && <span className="subtle-label"><RichContent content={texts.formEyebrow} settings={settings} inline /></span>}
    {texts[`${mode}Title`] && <h2><RichContent content={texts[`${mode}Title`]} settings={settings} inline /></h2>}
    <RichContent className="auth-form-description" content={texts[`${mode}Description`]} settings={settings} />
    <form onSubmit={submit}>
      <label>
        <RichContent content={texts.usernameLabel} settings={settings} inline />
        <input
          aria-label={text(texts.usernameLabel)}
          name="username"
          autoFocus={!preview}
          autoComplete="username"
          value={username}
          onChange={(event) => { event.currentTarget.setCustomValidity(""); setUsername(event.target.value); }}
          onInvalid={(event) => invalid(event, texts.usernameValidation)}
          placeholder={text(texts.usernamePlaceholder)}
          minLength={3}
          maxLength={40}
          pattern={String.raw`[\p{L}\p{N}_.\-]{3,40}`}
          required
          disabled={busy}
        />
      </label>
      <label>
        <RichContent content={texts.passwordLabel} settings={settings} inline />
        <input
          aria-label={text(texts.passwordLabel)}
          name="password"
          type="password"
          autoComplete={creating ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => { event.currentTarget.setCustomValidity(""); setPassword(event.target.value); }}
          onInvalid={(event) => invalid(event, texts.passwordValidation)}
          placeholder={text(creating ? texts.newPasswordPlaceholder : texts.passwordPlaceholder)}
          minLength={creating ? 12 : 1}
          maxLength={256}
          required
          disabled={busy}
        />
      </label>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button type="submit" className="button button-primary auth-submit" disabled={busy}>
        {busy ? <><LoaderCircle size={17} className="spin" /><RichContent content={texts.busySubmit} settings={settings} inline /></>
          : <><RichContent content={texts[`${mode}Submit`]} settings={settings} inline /><ArrowRight size={17} /></>}
      </button>
    </form>
    {mode !== "setup" && registrationEnabled && <div className="auth-switch">
      <RichContent content={mode === "register" ? texts.loginPrompt : texts.registerPrompt} settings={settings} inline />
      <button type="button" disabled={busy} onClick={() => onModeChange(mode === "register" ? "login" : "register")}>
        <RichContent content={mode === "register" ? texts.loginLink : texts.registerLink} settings={settings} inline />
      </button>
    </div>}
    {texts.securityNote && <div className="auth-note"><ShieldCheck size={15} /><RichContent content={texts.securityNote} settings={settings} inline /></div>}
  </div>;
}
