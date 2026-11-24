import { engineProfiles, type AgentEngine } from "../../../engines";
import { Markdown } from "../MessageView";
import DiscussionRecord, { parseDiscussion } from "./DiscussionRecord";

interface Report { agent: string; engine: string; model: string; status: string; task: string; text: string }

const statusNames: Record<string, string> = { completed: "已完成", interrupted: "已中断", error: "出错", conflict: "合并冲突" };

/** Reads the report blocks the Hub writes into a report message; anything else in it is shown as it is. */
export function parseReports(content: string): { reports: Report[]; rest: string } {
  const reports: Report[] = [];
  const rest = content.replace(/<clinavat_agent_report([^>]*)>\n?([\s\S]*?)\n?<\/clinavat_agent_report>/g, (_match, attributes: string, text: string) => {
    const values = Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    reports.push({ agent: values.agent ?? "", engine: values.engine ?? "", model: values.model ?? "", status: values.status ?? "", task: values.task ?? "", text });
    return "";
  }).trim();
  return { reports, rest };
}

export default function AgentReports({ content }: { content: string }) {
  const discussion = parseDiscussion(content);
  if (discussion) return <DiscussionRecord discussion={discussion} />;
  const { reports, rest } = parseReports(content);
  if (!reports.length) return <div className="message-plain">{content}</div>;
  return (
    <div className="agent-reports">
      {reports.map((report, index) => {
        const engine = report.engine in engineProfiles ? report.engine as AgentEngine : undefined;
        return (
          <details key={index} className="agent-report">
            <summary>
              {engine && <span className={`engine-logo engine-logo-${engine}`} aria-hidden="true" />}
              <strong>{report.agent}</strong>
              <span className={`agent-report-status agent-report-${report.status}`}>{statusNames[report.status] ?? report.status}</span>
              <span className="agent-report-task" title={report.task}>{report.task}</span>
            </summary>
            <div className="agent-report-meta">{engine ? engineProfiles[engine].label : report.engine} · {report.model}</div>
            <Markdown text={report.text} />
          </details>
        );
      })}
      {rest && <div className="message-plain">{rest}</div>}
    </div>
  );
}
