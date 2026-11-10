import { useEffect, useState } from "react";
import { Check, LoaderCircle, MessageCircleQuestion, Save } from "lucide-react";
import { api, errorText } from "../../api";
import type { QuestionPolicy } from "../../types";
import QuestionPolicyFields from "../chat/native/QuestionPolicyFields";
import { policySummary } from "../chat/native/questionPolicy";
import "../../styles/admin-site.css";

/** The site's defaults, which every user's conversations follow unless the user or the conversation sets its own. */
export default function QuestionDefaults() {
  const [saved, setSaved] = useState<QuestionPolicy | null>(null);
  const [draft, setDraft] = useState<QuestionPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<QuestionPolicy>("/admin/settings/questions", { signal: controller.signal })
      .then((value) => { setSaved(value); setDraft(value); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, []);
  const dirty = !!saved && !!draft && (saved.mode !== draft.mode || saved.timeoutMs !== draft.timeoutMs);
  return (
    <section className="admin-card admin-site-section" aria-busy={!saved || saving}>
      <div className="admin-card-heading"><div><MessageCircleQuestion size={17} /><h3>智能体提问</h3></div></div>
      <p className="admin-site-description">
        所有用户的默认设置：智能体提问后等待回答的时间，以及无人回答时视为跳过，还是保留问题、结束本轮并释放账号，等用户下次打开网页回答。
        用户可在「工作台设置 → 对话默认值」中覆盖，单个对话也可单独调整。
      </p>
      {!saved && !error && <div className="loading-state">正在读取…</div>}
      {saved && draft && (
        <form className="question-policy-settings" onSubmit={(event) => {
          event.preventDefault();
          setSaving(true); setError(""); setMessage("");
          api<QuestionPolicy>("/admin/settings/questions", { method: "PUT", body: JSON.stringify(draft) })
            .then((value) => { setSaved(value); setDraft(value); setMessage("已保存，跟随站点默认的对话从下一个问题起生效。"); })
            .catch((cause) => setError(errorText(cause)))
            .finally(() => setSaving(false));
        }}>
          <QuestionPolicyFields key={`${saved.mode}:${saved.timeoutMs}`} value={draft} disabled={saving} onChange={(value) => {
            setDraft({ mode: value.mode ?? draft.mode, timeoutMs: value.timeoutMs ?? draft.timeoutMs });
            setMessage("");
          }} />
          <div className="question-policy-settings-actions">
            <span>{policySummary(draft)}</span>
            <button type="submit" className="button button-primary button-small" disabled={saving || !dirty}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存
            </button>
          </div>
        </form>
      )}
      {error && <p className="admin-site-access-error" role="alert">{error}</p>}
      {message && <p className="admin-site-access-status" role="status"><Check size={13} />{message}</p>}
    </section>
  );
}
