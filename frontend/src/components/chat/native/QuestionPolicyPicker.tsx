import { useState } from "react";
import { ChevronDown, LoaderCircle, MessageCircleQuestion } from "lucide-react";
import type { QuestionPolicy, QuestionPreference, Session } from "../../../types";
import SettingsMenu from "../SettingsMenu";
import QuestionPolicyFields from "./QuestionPolicyFields";
import { durationLabel, modeLabel, policySummary, resolvePolicy } from "./questionPolicy";

interface Props {
  session?: Session;
  /** The user's defaults, which a conversation follows until it sets its own. */
  defaults: QuestionPolicy;
  onChange: (sessionId: string, value: QuestionPreference) => Promise<void>;
}

const preferenceOf = (session?: Session): QuestionPreference =>
  ({ mode: session?.question_mode ?? null, timeoutMs: session?.question_timeout_ms ?? null });

/** Unlike other conversation settings, this one applies to the next question even while a reply runs. */
export default function QuestionPolicyPicker({ session, defaults, onChange }: Props) {
  const [draft, setDraft] = useState<QuestionPreference>(preferenceOf(session));
  const [saving, setSaving] = useState(false);
  const effective = resolvePolicy(preferenceOf(session), defaults);
  const title = session ? `提问：${policySummary(effective)}` : `提问：新对话使用默认设置（${policySummary(defaults)}），发送第一条消息后可单独调整`;
  return (
    <SettingsMenu
      label="提问的等待方式"
      role="dialog"
      width={320}
      title={title}
      className="question-policy-trigger"
      disabled={!session || saving}
      trigger={(
        <>
          <span className="question-policy-symbol" aria-hidden="true">
            {saving ? <LoaderCircle size={18} className="spin" /> : <MessageCircleQuestion size={18} />}
          </span>
          <span className="settings-trigger-label">{durationLabel(effective.timeoutMs)} · {modeLabel(effective.mode)}</span>
          <ChevronDown size={12} className="settings-trigger-chevron" aria-hidden="true" />
        </>
      )}
    >
      {(close) => (
        <form className="question-policy-menu" onSubmit={(event) => {
          event.preventDefault();
          if (!session) return;
          setSaving(true);
          close();
          void onChange(session.id, draft).catch(() => setDraft(preferenceOf(session))).finally(() => setSaving(false));
        }}>
          <div className="settings-menu-heading"><span>提问的等待方式</span><span>仅当前对话</span></div>
          <QuestionPolicyFields key={session?.id} value={draft} inherited={defaults} onChange={setDraft} />
          <div className="question-policy-actions">
            <button type="button" className="button button-small" onClick={() => { setDraft(preferenceOf(session)); close(); }}>取消</button>
            <button type="submit" className="button button-primary button-small">保存</button>
          </div>
        </form>
      )}
    </SettingsMenu>
  );
}
