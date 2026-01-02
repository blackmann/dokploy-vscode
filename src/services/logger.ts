import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Dokploy');
  }
  return outputChannel;
}

export function log(message: string, data?: unknown): void {
  if (!outputChannel) {
    return;
  }

  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] ${message}`;

  if (data !== undefined) {
    line += ` ${JSON.stringify(data, null, 2)}`;
  }

  outputChannel.appendLine(line);
}

export function showOutput(): void {
  outputChannel?.show();
}
