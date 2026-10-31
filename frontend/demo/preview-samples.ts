// Sample files that showcase the workspace previewers in the static demo.

const architecture = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300" font-family="Inter, sans-serif">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d2a22"/><stop offset="1" stop-color="#13201a"/>
    </linearGradient>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 10 5 0 10z" fill="#b6e8b0"/>
    </marker>
  </defs>
  <rect width="640" height="300" rx="20" fill="url(#panel)"/>
  <g fill="#1f3327" stroke="#3d5c47" stroke-width="1.5">
    <rect x="40" y="110" width="140" height="80" rx="14"/>
    <rect x="250" y="110" width="140" height="80" rx="14"/>
    <rect x="460" y="50" width="140" height="70" rx="14"/>
    <rect x="460" y="180" width="140" height="70" rx="14"/>
  </g>
  <g fill="#e0e5df" font-size="16" font-weight="600" text-anchor="middle">
    <text x="110" y="156">Web UI</text><text x="320" y="156">Hub</text>
    <text x="530" y="91">Agents</text><text x="530" y="221">Dev Hosts</text>
  </g>
  <g stroke="#b6e8b0" stroke-width="2" fill="none" marker-end="url(#arrow)">
    <path d="M180 150H246"/><path d="M390 140 456 92"/><path d="M390 160 456 208"/>
  </g>
  <text x="320" y="282" fill="#7f8a81" font-size="12" text-anchor="middle">Clinavat · request flow</text>
</svg>
`;

const guide = `---
title: 请求日志接入指南
owner: platform
---

# 请求日志接入指南

本文说明如何为服务开启结构化请求日志。参见 [配置定义](../src/config.ts)。

## 架构

![请求链路](architecture.svg)

## 快速开始

1. 在 \`AppConfig\` 中设置 \`logLevel\`
2. 调用 \`createApp\` 注册中间件
3. 在日志平台中检索 \`request_id\`

\`\`\`ts
const app = createApp({ port: 3000, logLevel: "info" });
app.router.listen(3000);
\`\`\`

## 日志级别

| 级别 | 用途 | 默认 |
| --- | --- | :-: |
| debug | 本地排障 | |
| info | 线上常规 | ✓ |
| warn | 仅告警 | |

## 检查清单

- [x] 中间件已注册
- [x] 采样率可配置
- [ ] 接入告警规则

> 生产环境请避免开启 \`debug\` 级别，以免泄露请求体。
`;

const metrics = `date,requests,p95_ms,error_rate
2026-10-20,18234,182,0.41%
2026-10-21,19870,176,0.38%
2026-10-22,21455,191,0.52%
2026-10-23,20311,168,0.33%
2026-10-24,17602,159,0.29%
2026-10-25,15420,151,0.27%
2026-10-26,22987,204,0.61%
`;

const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
  cells: [
    { cell_type: "markdown", metadata: {}, source: ["# 延迟分析\n", "统计最近一周的 p95 延迟。"] },
    {
      cell_type: "code", execution_count: 1, metadata: {},
      source: ["import pandas as pd\n", "frame = pd.read_csv(\"data/metrics.csv\")\n", "frame[\"p95_ms\"].describe()"],
      outputs: [{ output_type: "execute_result", execution_count: 1, metadata: {}, data: { "text/plain": ["count      7.0\n", "mean     175.9\n", "max      204.0\n", "Name: p95_ms, dtype: float64"] } }],
    },
    {
      cell_type: "code", execution_count: 2, metadata: {},
      source: ["print(\"峰值出现在\", frame.loc[frame.p95_ms.idxmax(), \"date\"])"],
      outputs: [{ output_type: "stream", name: "stdout", text: ["峰值出现在 2026-10-26\n"] }],
    },
  ],
}, null, 1);

// Builds a small valid PDF; xref offsets are computed so pdf.js can open it without repair.
function buildPdf(): string {
  const lines = [
    ["F2", 26, 72, 740, "Request Logging Overview"],
    ["F1", 13, 72, 705, "Structured request logs for every service in the demo project."],
    ["F1", 13, 72, 680, "1. Register the middleware through createApp(config)."],
    ["F1", 13, 72, 660, "2. Choose a log level: debug, info or warn."],
    ["F1", 13, 72, 640, "3. Search by request_id on the logging platform."],
    ["F1", 11, 72, 90, "Clinavat demo document - generated sample PDF"],
  ] as const;
  const stream = [
    "0.95 0.97 0.95 rg 0 770 612 22 re f",
    "0.21 0.44 0.29 rg 72 725 120 3 re f",
    "0.1 0.12 0.1 rg",
    ...lines.map(([font, size, x, y, text]) => `BT /${font} ${size} Tf ${x} ${y} Td (${text}) Tj ET`),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export const previewSamples: Record<string, string> = {
  "docs/guide.md": guide,
  "docs/architecture.svg": architecture,
  "docs/overview.pdf": buildPdf(),
  "data/metrics.csv": metrics,
  "notebooks/latency.ipynb": notebook,
};

// Files the demo serves as raw bytes only, mirroring how the hub flags non-text content.
export const binarySamples = new Set(["docs/overview.pdf"]);
