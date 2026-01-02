import AnsiToHtml from 'ansi-to-html';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { DokployClient } from '../api/dokploy-client';
import { log } from '../services/logger';
import { Application, Container } from '../types/dokploy';

type LogType = 'error' | 'warning' | 'success' | 'info' | 'debug';

interface RuntimeLogsConfig {
  app: Application;
  client: DokployClient;
  containers: Container[];
  selectedContainerId: string;
  tail: number;
}

interface WebviewMessage {
  command: 'changeContainer' | 'changeTail' | 'refresh';
  containerId?: string;
  tail?: number;
}

interface ParsedLogLine {
  timestamp: Date | null;
  message: string;
}

interface LogStyle {
  type: LogType;
  bgClass: string;
  borderColor: string;
  badgeBg: string;
  badgeText: string;
}

const LOG_STYLES: Record<LogType, LogStyle> = {
  error: {
    type: 'error',
    bgClass: 'log-error',
    borderColor: '#f44336',
    badgeBg: 'rgba(244, 67, 54, 0.4)',
    badgeText: '#ff6b6b'
  },
  warning: {
    type: 'warning',
    bgClass: 'log-warning',
    borderColor: '#ff9800',
    badgeBg: 'rgba(255, 152, 0, 0.4)',
    badgeText: '#ffb74d'
  },
  success: {
    type: 'success',
    bgClass: 'log-success',
    borderColor: '#4caf50',
    badgeBg: 'rgba(76, 175, 80, 0.4)',
    badgeText: '#81c784'
  },
  info: {
    type: 'info',
    bgClass: 'log-info',
    borderColor: '#2196f3',
    badgeBg: 'rgba(33, 150, 243, 0.4)',
    badgeText: '#64b5f6'
  },
  debug: {
    type: 'debug',
    bgClass: 'log-debug',
    borderColor: '#9e9e9e',
    badgeBg: 'rgba(158, 158, 158, 0.3)',
    badgeText: '#bdbdbd'
  }
};

function parseLogLine(line: string): ParsedLogLine {
  const timestampRegex = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z| UTC)?)\s+(.*)$/;
  const match = line.match(timestampRegex);

  if (match) {
    const [, timestampStr, message] = match;
    const timestamp = new Date(timestampStr.replace(' UTC', 'Z').replace(' ', 'T'));
    return {
      timestamp: isNaN(timestamp.getTime()) ? null : timestamp,
      message: message.trim()
    };
  }

  return { timestamp: null, message: line };
}

function getLogType(message: string): LogStyle {
  const lowerMessage = message.toLowerCase();

  if (
    /(?:^|\s)(?:error|err):?\s/i.test(lowerMessage) ||
    /\b(?:exception|failed|failure)\b/i.test(lowerMessage) ||
    /(?:stack\s?trace):\s*$/i.test(lowerMessage) ||
    /^\s*at\s+[\w.]+\s*\(?.+:\d+:\d+\)?/.test(lowerMessage) ||
    /\b(?:uncaught|unhandled)\s+(?:exception|error)\b/i.test(lowerMessage) ||
    /\[(?:error|err|fatal)\]/i.test(lowerMessage) ||
    /\b(?:crash|critical|fatal)\b/i.test(lowerMessage)
  ) {
    return LOG_STYLES.error;
  }

  if (
    /(?:^|\s)(?:warning|warn):?\s/i.test(lowerMessage) ||
    /\[(?:warn(?:ing)?|attention)\]/i.test(lowerMessage) ||
    /(?:deprecated|obsolete)/i.test(lowerMessage) ||
    /\b(?:caution|attention|notice):\s/i.test(lowerMessage) ||
    /⚠|⚠️/i.test(lowerMessage)
  ) {
    return LOG_STYLES.warning;
  }

  if (
    /(?:successfully|complete[d]?)\s+(?:initialized|started|completed|created|done|deployed)/i.test(lowerMessage) ||
    /\[(?:success|ok|done)\]/i.test(lowerMessage) ||
    /(?:listening|running)\s+(?:on|at)\s+(?:port\s+)?\d+/i.test(lowerMessage) ||
    /(?:connected|established|ready)\s+(?:to|for|on)/i.test(lowerMessage) ||
    /✓|√|✅|\[ok\]|done!/i.test(lowerMessage) ||
    /\b(?:success(?:ful)?|completed|ready)\b/i.test(lowerMessage)
  ) {
    return LOG_STYLES.success;
  }

  if (
    /(?:^|\s)(?:info|inf|information):?\s/i.test(lowerMessage) ||
    /\[(?:info|information)\]/i.test(lowerMessage) ||
    /\b(?:status|state|current|progress)\b:?\s/i.test(lowerMessage) ||
    /\b(?:processing|executing|performing)\b/i.test(lowerMessage) ||
    /\b(?:cloning|building|installing|downloading|fetching)\b/i.test(lowerMessage)
  ) {
    return LOG_STYLES.info;
  }

  return LOG_STYLES.debug;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const ansiConverter = new AnsiToHtml({
  fg: 'inherit',
  bg: 'transparent',
  colors: {
    0: '#000000',
    1: '#cd3131',
    2: '#0dbc79',
    3: '#e5e510',
    4: '#2472c8',
    5: '#bc3fbc',
    6: '#11a8cd',
    7: '#e5e5e5',
    8: '#666666',
    9: '#f14c4c',
    10: '#23d18b',
    11: '#f5f543',
    12: '#3b8eea',
    13: '#d670d6',
    14: '#29b8db',
    15: '#e5e5e5'
  }
});

export class LogsWebview {
  private panel: vscode.WebviewPanel | undefined;
  private ws: WebSocket | undefined;
  private logBuffer: string = '';
  private timestamp = false;
  private runtimeConfig: RuntimeLogsConfig | undefined;
  private isRuntimeLogs = false;

  constructor(private extensionUri: vscode.Uri, timestamp = false) {
    this.timestamp = timestamp;
  }

  async showRuntimeLogs(app: Application, client: DokployClient): Promise<void> {
    log(`Opening runtime logs for: ${app.name}`);

    const containers = await client.getContainersByAppLabel(app.appName);

    if (containers.length === 0) {
      this.showEmptyState(app.name);
      return;
    }

    this.runtimeConfig = {
      app,
      client,
      containers,
      selectedContainerId: containers[0].containerId,
      tail: 100
    };
    this.isRuntimeLogs = true;

    this.createOrRevealPanel(`Runtime Logs: ${app.name}`);
    this.setupMessageHandler();
    this.connectToRuntimeLogs();
  }

  private showEmptyState(appName: string): void {
    this.createOrRevealPanel(`Runtime Logs: ${appName}`);
    this.isRuntimeLogs = true;
    this.setupMessageHandler();

    if (this.panel) {
      this.panel.webview.html = this.getEmptyStateHtml(appName);
    }
  }

  private createOrRevealPanel(title: string): void {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'dokployLogs',
        title,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.closeWebSocket();
        this.runtimeConfig = undefined;
        this.isRuntimeLogs = false;
      });
    }

    this.panel.title = title;
  }

  private setupMessageHandler(): void {
    if (!this.panel) return;

    this.panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (!this.runtimeConfig) return;

      switch (message.command) {
        case 'changeContainer':
          if (message.containerId) {
            this.runtimeConfig.selectedContainerId = message.containerId;
            this.connectToRuntimeLogs();
          }
          break;
        case 'changeTail':
          if (message.tail) {
            this.runtimeConfig.tail = message.tail;
            this.connectToRuntimeLogs();
          }
          break;
        case 'refresh':
          const containers = await this.runtimeConfig.client.getContainersByAppLabel(
            this.runtimeConfig.app.appName
          );
          if (containers.length === 0) {
            this.showEmptyState(this.runtimeConfig.app.name);
          } else {
            this.runtimeConfig.containers = containers;
            this.runtimeConfig.selectedContainerId = containers[0].containerId;
            this.connectToRuntimeLogs();
          }
          break;
      }
    });
  }

  private connectToRuntimeLogs(): void {
    if (!this.runtimeConfig || !this.panel) return;

    const { client, selectedContainerId, tail, app, containers } = this.runtimeConfig;
    const wsConfig = client.getRuntimeLogWsConfig(selectedContainerId, tail, app.serverId);

    this.logBuffer = '';
    this.updateRuntimeContent('Connecting to log stream...', containers, selectedContainerId, tail);
    this.connectWebSocket(wsConfig.url, wsConfig.headers, true);
  }

  private updateRuntimeContent(
    logContent: string,
    containers: Container[],
    selectedContainerId: string,
    tail: number
  ): void {
    if (!this.panel) return;

    const lines = logContent.split('\n');
    const htmlLines = lines.map(line => this.formatLogLine(line));

    this.panel.webview.html = this.getRuntimeHtml(
      htmlLines.join('\n'),
      containers,
      selectedContainerId,
      tail
    );
  }

  showWithWebSocket(title: string, wsUrl: string, headers?: Record<string, string>): void {
    log(`Opening logs webview with WebSocket: ${wsUrl}`);

    this.isRuntimeLogs = false;
    this.runtimeConfig = undefined;

    this.createOrRevealPanel(title);

    this.logBuffer = '';
    this.updateContent('Connecting to log stream...');
    this.connectWebSocket(wsUrl, headers, false);
  }

  private connectWebSocket(wsUrl: string, headers?: Record<string, string>, isRuntime = false): void {
    this.closeWebSocket();

    this.ws = new WebSocket(wsUrl, { headers });

    this.ws.on('open', () => {
      log('WebSocket connected');
      this.logBuffer = '';
      if (isRuntime && this.runtimeConfig) {
        const { containers, selectedContainerId, tail } = this.runtimeConfig;
        this.updateRuntimeContent('Connected. Waiting for logs...', containers, selectedContainerId, tail);
      } else {
        this.updateContent('Connected. Waiting for logs...');
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      const message = data.toString();
      this.logBuffer += message;
      if (isRuntime && this.runtimeConfig) {
        const { containers, selectedContainerId, tail } = this.runtimeConfig;
        this.updateRuntimeContent(this.logBuffer, containers, selectedContainerId, tail);
      } else {
        this.updateContent(this.logBuffer);
      }
    });

    this.ws.on('error', (error) => {
      log('WebSocket error:', error);
      const errorContent = `Connection error: ${error.message}\n\n${this.logBuffer}`;
      if (isRuntime && this.runtimeConfig) {
        const { containers, selectedContainerId, tail } = this.runtimeConfig;
        this.updateRuntimeContent(errorContent, containers, selectedContainerId, tail);
      } else {
        this.updateContent(errorContent);
      }
    });

    this.ws.on('close', () => {
      log('WebSocket closed');
      if (this.logBuffer) {
        const closedContent = this.logBuffer + '\n\n--- Log stream ended ---';
        if (isRuntime && this.runtimeConfig) {
          const { containers, selectedContainerId, tail } = this.runtimeConfig;
          this.updateRuntimeContent(closedContent, containers, selectedContainerId, tail);
        } else {
          this.updateContent(closedContent);
        }
      }
    });
  }

  private closeWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private updateContent(logContent: string): void {
    if (!this.panel) {
      return;
    }

    const lines = logContent.split('\n');
    const htmlLines = lines.map(line => {
      if (!line.trim()) {
        return '<div class="log-line log-empty">&nbsp;</div>';
      }

      const parsed = parseLogLine(line);
      const style = getLogType(parsed.message);
      const messageHtml = ansiConverter.toHtml(escapeHtml(parsed.message));
      const timestampHtml = this.timestamp ? parsed.timestamp
        ? `<span class="log-timestamp">${formatTimestamp(parsed.timestamp)}</span>`
        : '<span class="log-timestamp"></span>'
        : '';

      return `<div class="log-line ${style.bgClass}">
        <div class="log-border" style="background-color: ${style.borderColor}"></div>
        ${timestampHtml}
        <span class="log-badge" style="background-color: ${style.badgeBg}; color: ${style.badgeText}">${style.type}</span>
        <span class="log-message">${messageHtml}</span>
      </div>`;
    });

    this.panel.webview.html = this.getHtml(htmlLines.join('\n'));
  }

  private getHtml(content: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logs</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.4;
      padding: 0;
      margin: 0;
    }

    .toolbar {
      position: fixed;
      top: 0;
      right: 0;
      left: 0;
      padding: 8px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      z-index: 100;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .toolbar button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 12px;
    }

    .toolbar button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    #log-content {
      padding: 48px 8px 16px 8px;
    }

    .log-line {
      display: flex;
      align-items: start;
      gap: 8px;
      padding: 3px 8px;
      border-radius: 3px;
      margin-bottom: 1px;
      min-height: 22px;
    }

    .log-line:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .log-empty {
      height: 22px;
    }

    .log-border {
      width: 3px;
      flex-shrink: 0;
      border-radius: 2px;
      align-self: stretch;
    }

    .log-timestamp {
      width: 140px;
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      display: flex;
      align-items: center;
    }

    .log-badge {
      width: 54px;
      flex-shrink: 0;
      text-align: center;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .log-message {
      flex: 1;
      white-space: pre-wrap;
      word-break: break-all;
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    }

    /* Log type backgrounds */
    .log-error {
      background-color: rgba(244, 67, 54, 0.1);
    }
    .log-error:hover {
      background-color: rgba(244, 67, 54, 0.15);
    }

    .log-warning {
      background-color: rgba(255, 152, 0, 0.1);
    }
    .log-warning:hover {
      background-color: rgba(255, 152, 0, 0.15);
    }

    .log-success {
      background-color: rgba(76, 175, 80, 0.1);
    }
    .log-success:hover {
      background-color: rgba(76, 175, 80, 0.15);
    }

    .log-info {
      background-color: rgba(33, 150, 243, 0.1);
    }
    .log-info:hover {
      background-color: rgba(33, 150, 243, 0.15);
    }

    .log-debug {
      background-color: transparent;
    }

    /* Light theme adjustments */
    body.vscode-light .log-badge {
      font-weight: 700;
    }

    body.vscode-light .log-error .log-badge {
      color: #c62828;
      background-color: rgba(244, 67, 54, 0.25);
    }

    body.vscode-light .log-warning .log-badge {
      color: #e65100;
      background-color: rgba(255, 152, 0, 0.25);
    }

    body.vscode-light .log-success .log-badge {
      color: #2e7d32;
      background-color: rgba(76, 175, 80, 0.25);
    }

    body.vscode-light .log-info .log-badge {
      color: #1565c0;
      background-color: rgba(33, 150, 243, 0.25);
    }

    body.vscode-light .log-debug .log-badge {
      color: #616161;
      background-color: rgba(158, 158, 158, 0.25);
    }

    /* High contrast theme adjustments */
    body.vscode-high-contrast .log-line {
      border: 1px solid transparent;
    }
    body.vscode-high-contrast .log-error {
      border-color: #f44336;
    }
    body.vscode-high-contrast .log-warning {
      border-color: #ff9800;
    }
    body.vscode-high-contrast .log-success {
      border-color: #4caf50;
    }
    body.vscode-high-contrast .log-info {
      border-color: #2196f3;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="scrollToBottom()">Scroll to Bottom</button>
    <button onclick="copyLogs()">Copy</button>
  </div>
  <div id="log-content">${content}</div>
  <script>
    function scrollToBottom() {
      window.scrollTo(0, document.body.scrollHeight);
    }
    function copyLogs() {
      const logLines = document.querySelectorAll('.log-message');
      const text = Array.from(logLines).map(el => el.innerText).join('\\n');
      navigator.clipboard.writeText(text);
    }
    // Auto-scroll to bottom on initial load
    scrollToBottom();
  </script>
</body>
</html>`;
  }

  private formatLogLine(line: string): string {
    if (!line.trim()) {
      return '<div class="log-line log-empty">&nbsp;</div>';
    }

    const parsed = parseLogLine(line);
    const style = getLogType(parsed.message);
    const messageHtml = ansiConverter.toHtml(escapeHtml(parsed.message));
    const timestampHtml = this.timestamp && parsed.timestamp
      ? `<span class="log-timestamp">${formatTimestamp(parsed.timestamp)}</span>`
      : '';

    return `<div class="log-line ${style.bgClass}">
      <div class="log-border" style="background-color: ${style.borderColor}"></div>
      ${timestampHtml}
      <span class="log-badge" style="background-color: ${style.badgeBg}; color: ${style.badgeText}">${style.type}</span>
      <span class="log-message">${messageHtml}</span>
    </div>`;
  }

  private getRuntimeHtml(
    content: string,
    containers: Container[],
    selectedContainerId: string,
    tail: number
  ): string {
    const containerOptions = containers
      .map(c => `<option value="${c.containerId}" ${c.containerId === selectedContainerId ? 'selected' : ''}>${c.name} (${c.state})</option>`)
      .join('');

    const tailOptions = [100, 500, 1000, 5000]
      .map(t => `<option value="${t}" ${t === tail ? 'selected' : ''}>${t} lines</option>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Runtime Logs</title>
  <style>
    ${this.getSharedStyles()}

    .toolbar select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px 8px;
      border-radius: 2px;
      font-size: 12px;
      cursor: pointer;
    }

    .toolbar select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    .toolbar-left {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .toolbar-right {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .toolbar label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar" style="justify-content: space-between;">
    <div class="toolbar-left">
      <label>Container:</label>
      <select id="containerSelect" onchange="changeContainer(this.value)">
        ${containerOptions}
      </select>
      <label>Tail:</label>
      <select id="tailSelect" onchange="changeTail(this.value)">
        ${tailOptions}
      </select>
    </div>
    <div class="toolbar-right">
      <button onclick="scrollToBottom()">Scroll to Bottom</button>
      <button onclick="copyLogs()">Copy</button>
    </div>
  </div>
  <div id="log-content">${content}</div>
  <script>
    const vscode = acquireVsCodeApi();

    function changeContainer(containerId) {
      vscode.postMessage({ command: 'changeContainer', containerId });
    }

    function changeTail(tail) {
      vscode.postMessage({ command: 'changeTail', tail: parseInt(tail, 10) });
    }

    function scrollToBottom() {
      window.scrollTo(0, document.body.scrollHeight);
    }

    function copyLogs() {
      const logLines = document.querySelectorAll('.log-message');
      const text = Array.from(logLines).map(el => el.innerText).join('\\n');
      navigator.clipboard.writeText(text);
    }

    scrollToBottom();
  </script>
</body>
</html>`;
  }

  private getEmptyStateHtml(appName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Runtime Logs</title>
  <style>
    ${this.getSharedStyles()}

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 80vh;
      gap: 16px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state h2 {
      margin: 0;
      font-weight: 500;
      color: var(--vscode-foreground);
    }

    .empty-state p {
      margin: 0;
      text-align: center;
    }

    .empty-state button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 13px;
      margin-top: 8px;
    }

    .empty-state button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="empty-state">
    <h2>No Running Containers</h2>
    <p>There are no running containers for <strong>${escapeHtml(appName)}</strong>.<br>The application may be stopped or not yet deployed.</p>
    <button onclick="refresh()">Refresh</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
  }

  private getSharedStyles(): string {
    return `
    * {
      box-sizing: border-box;
    }

    body {
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.4;
      padding: 0;
      margin: 0;
    }

    .toolbar {
      position: fixed;
      top: 0;
      right: 0;
      left: 0;
      padding: 8px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      z-index: 100;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .toolbar button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 12px;
    }

    .toolbar button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    #log-content {
      padding: 48px 8px 16px 8px;
    }

    .log-line {
      display: flex;
      align-items: start;
      gap: 8px;
      padding: 3px 8px;
      border-radius: 3px;
      margin-bottom: 1px;
      min-height: 22px;
    }

    .log-line:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .log-empty {
      height: 22px;
    }

    .log-border {
      width: 3px;
      flex-shrink: 0;
      border-radius: 2px;
      align-self: stretch;
    }

    .log-timestamp {
      width: 140px;
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      display: flex;
      align-items: center;
    }

    .log-badge {
      width: 54px;
      flex-shrink: 0;
      text-align: center;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .log-message {
      flex: 1;
      white-space: pre-wrap;
      word-break: break-all;
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    }

    /* Log type backgrounds */
    .log-error {
      background-color: rgba(244, 67, 54, 0.1);
    }
    .log-error:hover {
      background-color: rgba(244, 67, 54, 0.15);
    }

    .log-warning {
      background-color: rgba(255, 152, 0, 0.1);
    }
    .log-warning:hover {
      background-color: rgba(255, 152, 0, 0.15);
    }

    .log-success {
      background-color: rgba(76, 175, 80, 0.1);
    }
    .log-success:hover {
      background-color: rgba(76, 175, 80, 0.15);
    }

    .log-info {
      background-color: rgba(33, 150, 243, 0.1);
    }
    .log-info:hover {
      background-color: rgba(33, 150, 243, 0.15);
    }

    .log-debug {
      background-color: transparent;
    }

    /* Light theme adjustments */
    body.vscode-light .log-badge {
      font-weight: 700;
    }

    body.vscode-light .log-error .log-badge {
      color: #c62828;
      background-color: rgba(244, 67, 54, 0.25);
    }

    body.vscode-light .log-warning .log-badge {
      color: #e65100;
      background-color: rgba(255, 152, 0, 0.25);
    }

    body.vscode-light .log-success .log-badge {
      color: #2e7d32;
      background-color: rgba(76, 175, 80, 0.25);
    }

    body.vscode-light .log-info .log-badge {
      color: #1565c0;
      background-color: rgba(33, 150, 243, 0.25);
    }

    body.vscode-light .log-debug .log-badge {
      color: #616161;
      background-color: rgba(158, 158, 158, 0.25);
    }

    /* High contrast theme adjustments */
    body.vscode-high-contrast .log-line {
      border: 1px solid transparent;
    }
    body.vscode-high-contrast .log-error {
      border-color: #f44336;
    }
    body.vscode-high-contrast .log-warning {
      border-color: #ff9800;
    }
    body.vscode-high-contrast .log-success {
      border-color: #4caf50;
    }
    body.vscode-high-contrast .log-info {
      border-color: #2196f3;
    }
    `;
  }

  dispose(): void {
    this.closeWebSocket();
    if (this.panel) {
      this.panel.dispose();
    }
  }
}
