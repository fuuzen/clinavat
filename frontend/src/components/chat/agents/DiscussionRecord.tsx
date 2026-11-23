import { MessagesSquare } from "lucide-react";
import { engineProfiles, type AgentEngine } from "../../../engines";
import type { DiscussionFormat } from "../../../types";
import { Markdown } from "../MessageView";
import { formatNames } from "./DiscussionCard";

interface Statement { participant: string; engine: string; model: string; stance?: string; status: string; text: string }
interface Parsed { format: DiscussionFormat; status: string; topic: string; rounds: { round: number; statements: Statement[] }[]; ranking?: string }

const attributes = (source: string) => Object.fromEntries([...source.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
const statusNames: Record<string, string> = { completed: "已完成", stopped: "已停止", error: "出错", timeout: "超时", interrupted: "已中断" };

/** Reads the record the Hub writes for a finished discussion; undefined when the message holds none. */
export function parseDiscussion(content: string): Parsed | undefined {
  const block = /<clinavat_discussion([^>]*)>([\s\S]*?)<\/clinavat_discussion>/.exec(content);
  if (!block) return undefined;
  const head = attributes(block[1]);
  const rounds = [...block[2].matchAll(/<round number="(\d+)">([\s\S]*?)<\/round>/g)].map((round) => ({
    round: Number(round[1]),
    statements: [...round[2].matchAll(/<statement([^>]*)>\n?([\s\S]*?)\n?<\/statement>/g)].map((statement) => {
      const values = attributes(statement[1]);
      return { participant: values.participant ?? "", engine: values.engine ?? "", model: values.model ?? "", stance: values.stance,
        status: values.status ?? "", text: statement[2] };
    }),
  }));
  return { format: (head.format ?? "council") as DiscussionFormat, status: head.status ?? "", topic: head.topic ?? "", rounds,
    ranking: /<ranking>([\s\S]*?)<\/ranking>/.exec(block[2])?.[1] };
}

const roundName = (format: DiscussionFormat, round: number) =>
  format === "council" ? (round === 1 ? "独立作答" : "互评与排名") : format === "review" ? "审阅" : `第 ${round} 轮`;

/** A discussion's record in the host conversation: each round folded, the last one open. */
export default function DiscussionRecord({ discussion }: { discussion: Parsed }) {
  return (
    <div className="discussion-record">
      <div className="discussion-record-head">
        <MessagesSquare size={13} aria-hidden="true" />
        <strong>{formatNames[discussion.format]}</strong>
        <span title={discussion.topic}>{discussion.topic}</span>
        <small>{statusNames[discussion.status] ?? discussion.status}</small>
      </div>
      {discussion.ranking && <div className="discussion-ranking">综合排名（得分）：{discussion.ranking}</div>}
      {discussion.rounds.map(({ round, statements }, index) => (
        <details key={round} className="discussion-round" open={index === discussion.rounds.length - 1}>
          <summary>{roundName(discussion.format, round)}</summary>
          <div className="discussion-statements">
            {statements.map((statement) => {
              const engine = statement.engine in engineProfiles ? statement.engine as AgentEngine : undefined;
              return (
                <article key={statement.participant} className={`discussion-statement statement-${statement.status}`}>
                  <header>
                    {engine && <span className={`engine-logo engine-logo-${engine}`} aria-hidden="true" />}
                    <strong>{statement.participant.replace(/^d\d+-/, "")}</strong>
                    {statement.stance && <small>{statement.stance}</small>}
                    <small>{statement.model}</small>
                    {statement.status !== "completed" && <small className="discussion-statement-status">{statusNames[statement.status] ?? statement.status}</small>}
                  </header>
                  <Markdown text={statement.text} />
                </article>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}
