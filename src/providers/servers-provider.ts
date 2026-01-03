import * as vscode from 'vscode';
import { ConfigService } from '../services/config-service';
import { DokployServerConfig } from '../types/dokploy';

export class ServerItem extends vscode.TreeItem {
  constructor(
    public readonly server: DokployServerConfig,
    public readonly isActive: boolean
  ) {
    super(server.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'server';
    this.description = isActive ? `${server.endpoint} (active)` : server.endpoint;
    this.iconPath = isActive
      ? new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('server');
  }
}

export class ServersProvider implements vscode.TreeDataProvider<ServerItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private configService: ConfigService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ServerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ServerItem[]> {
    const servers = this.configService.getServers();

    if (servers.length === 0) {
      return [];
    }

    const activeServerId = this.configService.getActiveServerId();
    return servers.map(server => new ServerItem(server, server.id === activeServerId));
  }
}
