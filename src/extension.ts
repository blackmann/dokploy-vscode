import * as vscode from 'vscode';
import { DeploymentsProvider } from './providers/deployments-provider';
import { ServerItem, ServersProvider } from './providers/servers-provider';
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
  const serversProvider = new ServersProvider(configService);
  const logsWebview = new LogsWebview(context.extensionUri);

  const deploymentsTreeView = vscode.window.createTreeView('dokployDeployments', {
    treeDataProvider: deploymentsProvider,
    showCollapseAll: true
  });

  const serversTreeView = vscode.window.createTreeView('dokployServers', {
    treeDataProvider: serversProvider
  });

  await deploymentsProvider.initialize();
  startAutoRefresh(deploymentsProvider, configService);

  log('Dokploy extension activated');

  context.subscriptions.push(
    deploymentsTreeView,
    serversTreeView,
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
        serversProvider.refresh();
        await deploymentsProvider.initialize();
        vscode.window.showInformationMessage(`Added server: ${server.name}`);
      }
    }),

    vscode.commands.registerCommand('dokploy.viewLogs', async (arg: Deployment | { data: Deployment}) => {
      const client = deploymentsProvider.getClient();

      const deployment = 'data' in arg ? arg.data : arg

      log('arg', deployment)
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
      const client = deploymentsProvider.getClient();
      if (!client) {
        vscode.window.showErrorMessage('Not connected to Dokploy server');
        return;
      }

      try {
        await logsWebview.showRuntimeLogs(app, client);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to fetch runtime logs: ${error}`);
      }
    }),

    vscode.commands.registerCommand('dokploy.openInBrowser', async (arg: Application | { data: Application }) => {
      const server = configService.getActiveServer();
      if (!server) {
        vscode.window.showErrorMessage('No active server configured');
        return;
      }

      const app = 'data' in arg ? arg.data : arg

      if (!app.environmentId) {
        vscode.window.showErrorMessage('Missing environment information for this application');
        return;
      }

      const serverUrl = server.endpoint.replace(/\/api$/, '');
      const url = `${serverUrl}/dashboard/project/${app.projectId}/environment/${app.environmentId}/services/application/${app.applicationId}`;
      log('Opening in browser:', url);
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('dokploy.redeploy', async (arg: Application | { data: Application}) => {
      const app = 'data' in arg ? arg.data : arg
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

    vscode.commands.registerCommand('dokploy.deleteServer', async (item: ServerItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `Delete server "${item.server.name}"?`,
        'Yes',
        'No'
      );

      if (confirm === 'Yes') {
        await configService.removeServer(item.server.id);
        serversProvider.refresh();
        await deploymentsProvider.initialize();
      }
    }),

    vscode.commands.registerCommand('dokploy.setActiveServer', async (item: ServerItem) => {
      await configService.setActiveServerId(item.server.id);
      serversProvider.refresh();
      await deploymentsProvider.initialize();
      vscode.window.showInformationMessage(`Active server: ${item.server.name}`);
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
