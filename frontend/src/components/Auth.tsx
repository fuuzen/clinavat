import { useState } from "react";
import { defaultSiteSettings, type SiteSettings } from "../site/settings";
import AuthFrame from "./auth/AuthFrame";
import AuthForm, { type AuthMode } from "./auth/AuthForm";
import AuthLayout from "./auth/AuthLayout";

interface Props {
  needsSetup: boolean;
  registrationEnabled: boolean;
  onAuthenticated: () => Promise<void>;
  settings?: SiteSettings;
  preview?: boolean;
  previewMode?: AuthMode;
}

export default function Auth({ needsSetup, registrationEnabled, onAuthenticated,
  settings = defaultSiteSettings, preview = false, previewMode }: Props) {
  const [selectedMode, setSelectedMode] = useState<AuthMode>("login");
  const mode = preview && previewMode ? previewMode
    : needsSetup ? "setup" : selectedMode === "register" && registrationEnabled ? "register" : "login";
  return <AuthFrame settings={settings} preview={preview}>
    <AuthLayout settings={settings}>
      <AuthForm settings={settings} mode={mode} registrationEnabled={registrationEnabled}
        preview={preview} onModeChange={setSelectedMode} onAuthenticated={onAuthenticated} />
    </AuthLayout>
  </AuthFrame>;
}
