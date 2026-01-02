import * as vscode from 'vscode';
import { DeploymentsProvider } from './providers/deployments-provider';
import { ConfigService } from './services/config-service';
import { GitService } from './services/git-service';
import { initLogger, log, showOutput } from './services/logger';
import { Application, Deployment } from './types/dokploy';
import { LogsWebview } from './views/logs-webview';

let refreshTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);

  log('Dokploy extension activating...');

  const configService = new ConfigService(context);
  const gitService = new GitService();
  const deploymentsProvider = new DeploymentsProvider(configService, gitService);
  const logsWebview = new LogsWebview(context.extensionUri);

  const treeView = vscode.window.createTreeView('dokployDeployments', {
    treeDataProvider: deploymentsProvider,
    showCollapseAll: true
  });

  await deploymentsProvider.initialize();
  startAutoRefresh(deploymentsProvider, configService);

  log('Dokploy extension activated');

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('dokploy.refresh', () => {
      log('Manual refresh triggered');
      deploymentsProvider.refresh();
    }),

    vscode.commands.registerCommand('dokploy.showOutput', () => {
      showOutput();
    }),

    vscode.commands.registerCommand('dokploy.addServer', async () => {
      const server = await configService.promptAddServer();
      if (server) {
        await deploymentsProvider.initialize();
        vscode.window.showInformationMessage(`Added server: ${server.name}`);
      }
    }),

    vscode.commands.registerCommand('dokploy.configure', async () => {
      const server = await configService.promptSelectServer();
      if (server) {
        await deploymentsProvider.initialize();
      }
    }),

    vscode.commands.registerCommand('dokploy.viewLogs', async (deployment: Deployment) => {
      const client = deploymentsProvider.getClient();
      if (!client || !deployment.logPath) {
        vscode.window.showErrorMessage('Unable to fetch logs');
        return;
      }

      const wsConfig = client.getDeploymentLogWsConfig(deployment.logPath);
      logsWebview.showWithWebSocket(
        `Deployment: ${deployment.title || deployment.deploymentId.slice(0, 8)}`,
        wsConfig.url,
        wsConfig.headers
      );
    }),

    vscode.commands.registerCommand('dokploy.viewRuntimeLogs', async (app: Application) => {
      vscode.window.showInformationMessage(`Runtime logs for ${app.name} - Coming soon`);
    }),

    vscode.commands.registerCommand('dokploy.openInBrowser', async (app: Application) => {
      console.log('domains....', app.domains)
      if (app.domains && app.domains.length > 0) {
        const domain = app.domains[0];
        const protocol = domain.https ? 'https' : 'http';
        const url = `${protocol}://${domain.host}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showWarningMessage('No domain configured for this application');
      }
    }),

    vscode.commands.registerCommand('dokploy.redeploy', async (app: Application) => {
      const client = deploymentsProvider.getClient();
      if (!client) {
        vscode.window.showErrorMessage('Not connected to Dokploy server');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Redeploy ${app.name}?`,
        'Yes',
        'No'
      );

      if (confirm === 'Yes') {
        try {
          await client.redeploy(app.applicationId);
          vscode.window.showInformationMessage(`Redeploying ${app.name}...`);
          deploymentsProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to redeploy: ${error}`);
        }
      }
    }),

    { dispose: () => logsWebview.dispose() }
  );
}

function startAutoRefresh(provider: DeploymentsProvider, configService: ConfigService): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const interval = configService.getRefreshInterval() * 1000;
  refreshTimer = setInterval(() => {
    provider.refresh();
  }, interval);
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}
