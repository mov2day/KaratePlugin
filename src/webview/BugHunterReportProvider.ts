import * as vscode from 'vscode';
import { BugFinding, BugHunterProbeReport, BugHunterRunResult } from '../types';

export function showBugHunterReport(result: BugHunterRunResult, reproFile?: string): void {
    const panel = vscode.window.createWebviewPanel(
        'karateBugHunterReport',
        'Karate API Bug Hunter',
        vscode.ViewColumn.One
    );

    panel.webview.html = render(result, reproFile);
}

function render(result: BugHunterRunResult, reproFile?: string): string {
    const grouped = groupByCategory(result.findings);
    const cards = result.findings.length === 0
        ? '<section class="empty">No findings. Check Probe Trace below for executed probes, skipped probes, and response status.</section>'
        : result.findings.map((finding) => findingCard(finding)).join('');
    const trace = probeTrace(result.probes);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Karate API Bug Hunter</title>
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      padding: 20px;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 16px;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 6px;
      font-weight: 650;
    }
    h2 {
      font-size: 15px;
      margin: 0 0 10px;
      font-weight: 650;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric, .finding, .empty {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      background: var(--vscode-editorWidget-background);
    }
    .metric strong {
      display: block;
      font-size: 20px;
      margin-bottom: 2px;
    }
    .metric span, .muted {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .trace {
      margin-bottom: 18px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px;
      vertical-align: top;
      font-size: 12px;
    }
    th {
      color: var(--vscode-descriptionForeground);
      font-weight: 650;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .probe-name {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      margin-top: 2px;
    }
    .status {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .status.executed {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }
    .status.skipped {
      background: var(--vscode-testing-iconSkipped);
      color: var(--vscode-editor-background);
    }
    .finding {
      margin-bottom: 12px;
    }
    .finding-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 8px;
    }
    .endpoint {
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
    }
    .badge {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      text-transform: uppercase;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
    }
    pre {
      overflow: auto;
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      font-size: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
    }
    .export {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Karate API Bug Hunter</h1>
      <div class="muted">${escapeHtml(result.baseUrl)} | ${new Date(result.startedAt).toLocaleString()}</div>
    </div>
    <div class="export">${reproFile ? `Exported: ${escapeHtml(reproFile)}` : 'No repro file exported'}</div>
  </header>

  <section class="summary">
    <div class="metric"><strong>${result.findings.length}</strong><span>findings</span></div>
    <div class="metric"><strong>${result.totalProbes}</strong><span>probe candidates</span></div>
    <div class="metric"><strong>${result.executedProbes}</strong><span>probes executed</span></div>
    <div class="metric"><strong>${result.skippedProbes}</strong><span>probes skipped</span></div>
    <div class="metric"><strong>${escapeHtml(Object.entries(grouped).map(([key, value]) => `${key}:${value}`).join(' ') || 'none')}</strong><span>categories</span></div>
  </section>

  ${trace}
  ${cards}
</body>
</html>`;
}

function findingCard(finding: BugFinding): string {
    return `<article class="finding" id="${escapeHtml(finding.id)}">
  <div class="finding-head">
    <div>
      <h2>${escapeHtml(finding.category)}</h2>
      <div class="endpoint">${escapeHtml(finding.endpoint.method)} ${escapeHtml(finding.endpoint.path)}</div>
    </div>
    <span class="badge">${escapeHtml(finding.severity)}</span>
  </div>
  <div class="grid">
    <div>
      <div class="muted">Expected</div>
      <pre>${escapeHtml(finding.expected)}</pre>
    </div>
    <div>
      <div class="muted">Observed</div>
      <pre>${escapeHtml(finding.observed)}</pre>
    </div>
  </div>
  <div class="muted">curl reproducer</div>
  <pre>${escapeHtml(finding.curl)}</pre>
  <details>
    <summary>Karate scenario</summary>
    <pre>${escapeHtml(finding.karateScenario)}</pre>
  </details>
</article>`;
}

function probeTrace(probes: BugHunterProbeReport[]): string {
    if (probes.length === 0) {
        return '<section class="empty">No probes were built from this spec.</section>';
    }

    return `<section class="trace">
  <h2>Probe Trace</h2>
  <table>
    <thead>
      <tr>
        <th>Probe</th>
        <th>Category</th>
        <th>Status</th>
        <th>HTTP</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      ${probes.map(probeRow).join('')}
    </tbody>
  </table>
</section>`;
}

function probeRow(probe: BugHunterProbeReport): string {
    const detail = probe.status === 'skipped'
        ? escapeHtml(probe.reason || 'Skipped')
        : probe.findingId
            ? `<a href="#${escapeHtml(probe.findingId)}">finding ${escapeHtml(probe.findingId)}</a>`
            : 'No finding';
    const http = probe.status === 'executed'
        ? `${probe.responseStatus ?? 'n/a'}${probe.durationMs !== undefined ? ` / ${probe.durationMs}ms` : ''}`
        : '-';

    return `<tr>
  <td>
    <strong>${escapeHtml(probe.method)} ${escapeHtml(probe.path)}</strong>
    <div class="probe-name">${escapeHtml(probe.name)}</div>
  </td>
  <td>${escapeHtml(probe.category || '-')}</td>
  <td><span class="status ${probe.status}">${escapeHtml(probe.status)}</span></td>
  <td>${escapeHtml(http)}</td>
  <td>${detail}</td>
</tr>`;
}

function groupByCategory(findings: BugFinding[]): Record<string, number> {
    return findings.reduce<Record<string, number>>((acc, finding) => {
        acc[finding.category] = (acc[finding.category] || 0) + 1;
        return acc;
    }, {});
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
