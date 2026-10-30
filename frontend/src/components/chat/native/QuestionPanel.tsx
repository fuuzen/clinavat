import { useEffect, useRef, useState } from "react";
import { HelpCircle, LoaderCircle } from "lucide-react";
import { api, errorText, post } from "../../../api";
import "../../../styles/native-chat.css";

interface Question {
  id: string;
  header: string;
  question: string;
  isSecret?: boolean;
  multiSelect?: boolean;
  options?: { label: string; description: string }[];
}
interface QuestionRequest {
  id: string;
  session_id: string;
  questions: Question[];
}

function QuestionForm({ request, onAnswered }: { request: QuestionRequest; onAnswered: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const pendingRef = useRef(false);
  async function submit(skip: boolean) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setSending(true); setError("");
    try {
      await post(`/sessions/${request.session_id}/questions/${encodeURIComponent(request.id)}`, skip ? { skip: true } : {
        answers: Object.fromEntries(request.questions.map((question) => [question.id,
          [...(answers[question.id] || []), ...(custom[question.id]?.trim() ? [custom[question.id].trim()] : [])],
        ])),
      });
      onAnswered();
    } catch (cause) { setError(errorText(cause)); }
    finally { pendingRef.current = false; setSending(false); }
  }
  return <form className="agent-question" onSubmit={(event) => { event.preventDefault(); void submit(false); }}>
    <div className="agent-question-heading" aria-live="polite"><HelpCircle size={16} /><strong>需要你的意见</strong></div>
    {request.questions.map((question, index) => <fieldset key={question.id} disabled={sending}>
      <legend>{question.header || `问题 ${index + 1}`}</legend>
      <p>{question.question}</p>
      {question.options?.map((option) => <label className="agent-question-option" key={option.label}>
        <input type={question.multiSelect ? "checkbox" : "radio"} name={`${request.id}:${question.id}`} checked={answers[question.id]?.includes(option.label) || false} onChange={() => {
          setAnswers((current) => ({ ...current, [question.id]: question.multiSelect
            ? current[question.id]?.includes(option.label) ? current[question.id].filter((value) => value !== option.label) : [...(current[question.id] || []), option.label]
            : [option.label] }));
          if (!question.multiSelect) setCustom((current) => ({ ...current, [question.id]: "" }));
        }} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}
      <input className="agent-question-answer" type={question.isSecret ? "password" : "text"} autoComplete="off" aria-label={`${question.header || question.question}：回答`} placeholder="也可以输入自己的答案…" maxLength={10000} value={custom[question.id] || ""} onChange={(event) => {
        setCustom((current) => ({ ...current, [question.id]: event.target.value }));
        if (!question.multiSelect) setAnswers((current) => ({ ...current, [question.id]: [] }));
      }} />
    </fieldset>)}
    {error && <p className="agent-question-error" role="alert">{error}</p>}
    <div className="agent-question-actions">
      <button className="button" type="button" disabled={sending} onClick={() => void submit(true)}>跳过</button>
      <button className="button button-primary" type="submit" disabled={sending || request.questions.some((question) => !answers[question.id]?.length && !custom[question.id]?.trim())}>{sending && <LoaderCircle size={14} className="spin" />}提交回答</button>
    </div>
  </form>;
}

export default function QuestionPanel({ sessionId, connected }: { sessionId?: string; connected: boolean }) {
  const [requests, setRequests] = useState<QuestionRequest[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("clinavat:user-input", refresh);
    return () => window.removeEventListener("clinavat:user-input", refresh);
  }, []);
  useEffect(() => { setRequests([]); setError(""); }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void api<QuestionRequest[]>(`/sessions/${sessionId}/questions`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setRequests(value); setError(""); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [sessionId, revision, connected]);
  return <>
    {requests.filter((request) => request.session_id === sessionId).map((request) => <QuestionForm key={request.id} request={request} onAnswered={() => setRequests((current) => current.filter((item) => item.id !== request.id))} />)}
    {error && <div className="agent-question-error" role="status">问题加载失败：{error}<button className="button" onClick={() => setRevision((value) => value + 1)}>重试</button></div>}
  </>;
}
