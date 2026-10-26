export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
}

export default function EndpointFields({
  prefix = "",
  label = "开发机",
  value,
  onChange,
}: {
  prefix?: string;
  label?: string;
  value: SshEndpoint;
  onChange: (value: SshEndpoint) => void;
}) {
  return (
    <>
      <div className="form-row form-row-host">
        <label>
          {label}地址
          <input
            name={`${prefix}host`}
            value={value.host}
            onChange={(event) => onChange({ ...value, host: event.target.value })}
            placeholder="域名或 IP 地址"
            maxLength={253}
            required
          />
        </label>
        <label>
          {label}端口
          <input
            name={`${prefix}port`}
            type="number"
            value={value.port}
            onChange={(event) => onChange({ ...value, port: Number(event.target.value) })}
            min={1}
            max={65535}
            required
          />
        </label>
      </div>
      <label>
        {label} SSH 用户名
        <input
          name={`${prefix}username`}
          value={value.username}
          onChange={(event) => onChange({ ...value, username: event.target.value })}
          placeholder="远程登录用户名"
          maxLength={64}
          pattern="[a-zA-Z_][a-zA-Z0-9_.-]*"
          required
        />
      </label>
    </>
  );
}
