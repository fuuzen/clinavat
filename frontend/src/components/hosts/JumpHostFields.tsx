import { Route } from "lucide-react";
import EndpointFields, { type SshEndpoint } from "./EndpointFields";
import IdentityFields from "./IdentityFields";

function destination(endpoint: SshEndpoint) {
  const address = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.username || "user"}@${address || "host"}`;
}

export default function JumpHostFields({
  enabled,
  onEnabledChange,
  value,
  onChange,
  target,
  editing,
  publicKey,
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  value: SshEndpoint;
  onChange: (value: SshEndpoint) => void;
  target: SshEndpoint;
  editing: boolean;
  publicKey?: string;
}) {
  return (
    <div className="jump-host-section">
      <label className="jump-host-toggle">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        <Route size={16} />
        通过跳板机连接
      </label>
      {enabled && (
        <div className="jump-host-fields">
          <p className="host-help">先连接跳板机，再由它访问开发机。两台机器可使用不同的用户名、端口和密钥。</p>
          <EndpointFields prefix="jump-" label="跳板机" value={value} onChange={onChange} />
          <IdentityFields name="jumpPrivateKey" label="跳板机" editing={editing} publicKey={publicKey} />
          <div className="ssh-command-preview">
            <span>对应的 SSH 连接方式</span>
            <code>ssh -J {destination(value)}:{value.port || 22} -p {target.port || 22} {destination(target)}</code>
          </div>
        </div>
      )}
    </div>
  );
}
