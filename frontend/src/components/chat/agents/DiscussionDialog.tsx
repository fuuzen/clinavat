import { useState, type FormEvent } from "react";
import { LoaderCircle, Plus, X } from "lucide-react";
import { errorText, post } from "../../../api";
import { agentEngines, engineProfiles, type AgentEngine } from "../../../engines";
import type { DiscussionFormat, Overview, Project } from "../../../types";
import { Modal } from "../../Dialogs";
import { formatNames } from "./DiscussionCard";

interface Seat { name: string; engine: AgentEngine; slotId: string; stance: string }

const formats: { value: DiscussionFormat; description: string }[] = [
  { value: "council", description: "所有人独立作答，再匿名互评并排名，适合开放问题和方案选型。" },
  { value: "debate", description: "每人从给定的立场或视角出发，多轮回应彼此，全员同意或到达轮数上限时结束。" },
  { value: "review", description: "所有人并行审阅同一份改动、分支或文件，按严重程度列出问题。" },
];

/** Starts a discussion among CLIs from the web; a new moderator conversation hosts it and synthesizes the record. */
export default function DiscussionDialog({ overview, project, onClose, onCreated }: {
  overview: Overview;
  project: Project;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}) {
  const engines = agentEngines.filter((engine) => overview.slots.some((slot) => slot.engine === engine));
  // Different vendors by default: independent views are the point of a discussion.
  const [seats, setSeats] = useState<Seat[]>(() => [0, 1].map((index) => {
    const engine = engines[index % Math.max(engines.length, 1)] ?? "claude";
    return { name: `${engine}${index >= engines.length ? index + 1 : ""}`, engine, slotId: "", stance: "" };
  }));
  const [topic, setTopic] = useState("");
  const [format, setFormat] = useState<DiscussionFormat>("council");
  const [rounds, setRounds] = useState("");
  const [moderator, setModerator] = useState<{ engine: AgentEngine; slotId: string }>({ engine: engines[0] ?? "claude", slotId: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const slotsOf = (engine: AgentEngine) => overview.slots.filter((slot) => slot.engine === engine);
  const update = (index: number, change: Partial<Seat>) => setSeats(seats.map((seat, position) => position === index ? { ...seat, ...change } : seat));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const created = await post<{ sessionId: string }>(`/projects/${project.id}/discussions`, {
        topic, format,
        participants: seats.map((seat) => ({ name: seat.name.trim(), engine: seat.engine, ...(seat.slotId ? { slot: seat.slotId } : {}),
          ...(format === "debate" && seat.stance.trim() ? { stance: seat.stance.trim() } : {}) })),
        ...(format === "debate" && rounds ? { rounds: Number(rounds) } : {}),
        moderator: { engine: moderator.engine, ...(moderator.slotId ? { slotId: moderator.slotId } : {}) },
      });
      onCreated(created.sessionId);
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  }

  const slotSelect = (engine: AgentEngine, value: string, onChange: (slotId: string) => void, label: string) => (
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={saving} aria-label={label}>
      <option value="">{engineProfiles[engine].automaticSlot ? "自动选择账号" : "第一个空闲的账号"}</option>
      {slotsOf(engine).map((slot) => <option key={slot.id} value={slot.id}>{slot.label}</option>)}
    </select>
  );
  return (
    <Modal title="发起讨论" subtitle={project.name} wide onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form discussion-form" onSubmit={submit}>
        <label>
          {format === "review" ? "审阅什么" : "讨论的问题"}
          <textarea value={topic} onChange={(event) => setTopic(event.target.value)} disabled={saving} required rows={4}
            placeholder={format === "review" ? "例如：当前未提交的改动，或 src/cache 目录" : "例如：缓存层应该用 Redis 还是进程内缓存？"} />
        </label>
        <fieldset className="discussion-formats" disabled={saving}>
          <legend>形式</legend>
          {formats.map((item) => (
            <label key={item.value} className={format === item.value ? "selected" : ""}>
              <input type="radio" name="format" value={item.value} checked={format === item.value} onChange={() => setFormat(item.value)} />
              <strong>{formatNames[item.value]}</strong>
              <small>{item.description}</small>
            </label>
          ))}
        </fieldset>
        <fieldset className="discussion-seats" disabled={saving}>
          <legend>参与者（只读，各自一个子对话）</legend>
          {seats.map((seat, index) => (
            <div key={index} className="discussion-seat">
              <input value={seat.name} onChange={(event) => update(index, { name: event.target.value })} required maxLength={24}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]*" title="字母、数字、- 和 _" aria-label={`参与者 ${index + 1} 的名字`} />
              <select value={seat.engine} onChange={(event) => update(index, { engine: event.target.value as AgentEngine, slotId: "" })}
                aria-label={`参与者 ${index + 1} 的 CLI`}>
                {engines.map((engine) => <option key={engine} value={engine}>{engineProfiles[engine].label}</option>)}
              </select>
              {slotSelect(seat.engine, seat.slotId, (slotId) => update(index, { slotId }), `参与者 ${index + 1} 的账号`)}
              {format === "debate" && <input value={seat.stance} onChange={(event) => update(index, { stance: event.target.value })}
                placeholder="立场或视角，如：支持 / 安全" maxLength={500} aria-label={`参与者 ${index + 1} 的立场`} />}
              <button type="button" className="icon-button" onClick={() => setSeats(seats.filter((_, position) => position !== index))}
                disabled={seats.length <= 1} aria-label={`移除参与者 ${index + 1}`}><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="button button-ghost button-small" onClick={() => {
            const engine = engines[seats.length % Math.max(engines.length, 1)] ?? "claude";
            setSeats([...seats, { name: `${engine}${seats.length + 1}`, engine, slotId: "", stance: "" }]);
          }}><Plus size={13} />添加参与者</button>
        </fieldset>
        <div className="form-row">
          <label>
            主持模型（新建一个对话，最后综合讨论记录）
            <div className="discussion-moderator">
              <select value={moderator.engine} onChange={(event) => setModerator({ engine: event.target.value as AgentEngine, slotId: "" })} disabled={saving}
                aria-label="主持模型的 CLI">
                {engines.map((engine) => <option key={engine} value={engine}>{engineProfiles[engine].label}</option>)}
              </select>
              {slotSelect(moderator.engine, moderator.slotId, (slotId) => setModerator({ ...moderator, slotId }), "主持模型的账号")}
            </div>
          </label>
          {format === "debate" && (
            <label>
              最多轮数
              <input type="number" min={1} max={10} value={rounds} onChange={(event) => setRounds(event.target.value)} placeholder="管理员设置的上限" disabled={saving} />
            </label>
          )}
        </div>
        <p className="form-hint">参与者只读，授权模式不高于主持对话；每一轮由本系统组织，参与者的完整上下文保留在各自的子对话中，可以单独打开追问。</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={saving} onClick={onClose}>取消</button>
          <button className="button button-primary" disabled={saving || !topic.trim() || !engines.length || (format !== "review" && seats.length < 2)}>
            {saving && <LoaderCircle className="spin" size={15} />}
            {saving ? "正在创建参与者…" : "开始讨论"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
