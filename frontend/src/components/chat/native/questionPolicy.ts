import type { QuestionMode, QuestionPolicy, QuestionPreference } from "../../../types";

export const questionModeOptions: { value: QuestionMode; label: string; description: string }[] = [
  { value: "skip", label: "视为跳过", description: "等待时间到后，智能体依据已有信息继续。" },
  { value: "defer", label: "转为待回答", description: "等待时间到后保留问题并结束本轮，账号随即释放；下次打开网页回答，答案作为新消息发送后继续。" },
];

export const questionTimeoutMinutes = { min: 1, max: 24 * 60 };
export const questionTimeoutPresets = [1, 5, 15, 30, 60, 120, 480, 1440].map((minutes) => minutes * 60_000);

export function durationLabel(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

export function modeLabel(mode: QuestionMode): string {
  return questionModeOptions.find((option) => option.value === mode)?.label || mode;
}

export function policySummary(policy: QuestionPolicy): string {
  return `${durationLabel(policy.timeoutMs)}未回答则${modeLabel(policy.mode)}`;
}

export function resolvePolicy(preference: QuestionPreference, fallback: QuestionPolicy): QuestionPolicy {
  return { mode: preference.mode ?? fallback.mode, timeoutMs: preference.timeoutMs ?? fallback.timeoutMs };
}
