import { useEffect, useState } from "react";
import { LoaderCircle, MessageCircleQuestion, Save } from "lucide-react";
import { api, errorText } from "../../api";
import type { QuestionPolicy, QuestionPreference } from "../../types";
import QuestionPolicyFields from "../chat/native/QuestionPolicyFields";
import { policySummary, resolvePolicy } from "../chat/native/questionPolicy";

interface QuestionSettingsView {
  site: QuestionPolicy;
  user: QuestionPreference;
}

/** The user's defaults for conversations that have not set their own. */
export default function QuestionSettings() {
  const [view, setView] = useState<QuestionSettingsView | null>(null);
  const [draft, setDraft] = useState<QuestionPreference>({ mode: null, timeoutMs: null });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<QuestionSettingsView>("/settings/questions", { signal: controller.signal })
      .then((value) => { setView(value); setDraft(value.user); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, []);
  const dirty = !!view && (draft.mode !== view.user.mode || draft.timeoutMs !== view.user.timeoutMs);
  return (
    <>
      <div className="settings-section-heading">
        <MessageCircleQuestion size={17} />
        <h3>智能体提问</h3>
      </div>
      <p className="settings-description">
        智能体向你提问时，等待回答的时间和无人回答时的处理方式。作为你所有对话的默认值；单个对话可在输入框底部的提问菜单中单独调整。
      </p>
      {!view && !error && <div className="loading-state">正在读取…</div>}
      {view && (
        <form className="question-policy-settings" onSubmit={(event) => {
          event.preventDefault();
          setSaving(true); setError(""); setMessage("");
          api<QuestionSettingsView>("/settings/questions", { method: "PUT", body: JSON.stringify(draft) })
            .then((value) => { setView(value); setDraft(value.user); setMessage("已保存，之后的提问按新设置处理。"); })
            .catch((cause) => setError(errorText(cause)))
            .finally(() => setSaving(false));
        }}>
          <QuestionPolicyFields key={`${view.user.mode}:${view.user.timeoutMs}`} value={draft} inherited={view.site}
            inheritedLabel="跟随站点默认" disabled={saving} onChange={(value) => { setDraft(value); setMessage(""); }} />
          <div className="question-policy-settings-actions">
            <span>当前生效：{policySummary(resolvePolicy(draft, view.site))}</span>
            <button type="submit" className="button button-primary button-small" disabled={saving || !dirty}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存
            </button>
          </div>
        </form>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {message && <p className="settings-description" role="status">{message}</p>}
    </>
  );
}
