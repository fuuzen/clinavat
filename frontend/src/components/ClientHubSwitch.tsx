import { ArrowLeftRight } from "lucide-react";
import { useClientShell } from "../client";

/** Renders only inside the Clinavat main window, where it returns to the client's Hub list. */
export default function ClientHubSwitch({ compact = false, className = "button button-ghost" }: {
  compact?: boolean;
  className?: string;
}) {
  const shell = useClientShell();
  if (!shell?.switchHubUrl) return null;
  const switchHubUrl = shell.switchHubUrl;
  const leave = () => window.location.assign(switchHubUrl);
  return compact
    ? <button className="icon-button" onClick={leave} title="切换 Hub" aria-label="切换 Hub"><ArrowLeftRight size={16} /></button>
    : <button type="button" className={className} onClick={leave}><ArrowLeftRight size={16} />切换 Hub</button>;
}
