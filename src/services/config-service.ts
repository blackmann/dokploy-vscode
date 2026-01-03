import * as vscode from 'vscode';
import { DokployServerConfig } from '../types/dokploy';

const API_KEY_PREFIX = 'dokploy.apiKey.';

export class ConfigService {
  private secrets: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets;
  }

  getServers(): DokployServerConfig[] {
    const config = vscode.workspace.getConfiguration('dokploy');
    return config.get<DokployServerConfig[]>('servers', []);
  }

  async addServer(server: DokployServerConfig, apiKey: string): Promise<void> {
    const servers = this.getServers();
    const isFirstServer = servers.length === 0;
    servers.push(server);
    await this.updateServers(servers);
    await this.secrets.store(`${API_KEY_PREFIX}${server.id}`, apiKey);

    if (isFirstServer) {
      await this.setActiveServerId(server.id);
    }
  }

  async updateServer(server: DokployServerConfig, apiKey?: string): Promise<void> {
    const servers = this.getServers();
    const index = servers.findIndex(s => s.id === server.id);
    if (index >= 0) {
      servers[index] = server;
      await this.updateServers(servers);
      if (apiKey) {
        await this.secrets.store(`${API_KEY_PREFIX}${server.id}`, apiKey);
      }
    }
  }

  async removeServer(serverId: string): Promise<void> {
    const servers = this.getServers().filter(s => s.id !== serverId);
    await this.updateServers(servers);
    await this.secrets.delete(`${API_KEY_PREFIX}${serverId}`);

    if (this.getActiveServerId() === serverId) {
      const newActive = servers.length > 0 ? servers[0].id : undefined;
      await this.setActiveServerId(newActive);
    }
  }

  async getApiKey(serverId: string): Promise<string | undefined> {
    return this.secrets.get(`${API_KEY_PREFIX}${serverId}`);
  }

  getRefreshInterval(): number {
    const config = vscode.workspace.getConfiguration('dokploy');
    return config.get<number>('refreshInterval', 30);
  }

  getActiveServerId(): string | undefined {
    const config = vscode.workspace.getConfiguration('dokploy');
    return config.get<string>('activeServerId');
  }

  async setActiveServerId(serverId: string | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration('dokploy');
    await config.update('activeServerId', serverId, vscode.ConfigurationTarget.Global);
  }

  getActiveServer(): DokployServerConfig | undefined {
    const activeId = this.getActiveServerId();
    if (!activeId) {
      return undefined;
    }
    return this.getServers().find(s => s.id === activeId);
  }

  private async updateServers(servers: DokployServerConfig[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('dokploy');
    await config.update('servers', servers, vscode.ConfigurationTarget.Global);
  }

  async promptAddServer(): Promise<DokployServerConfig | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Server name',
      placeHolder: 'My Dokploy Server'
    });
    if (!name) {
      return undefined;
    }

    const existingServer = this.getServers().find(s => s.name === name);
    if (existingServer) {
      const override = await vscode.window.showWarningMessage(
        `A server named "${name}" already exists. Override it?`,
        'Yes',
        'No'
      );
      if (override !== 'Yes') {
        return undefined;
      }
    }

    const endpoint = await vscode.window.showInputBox({
      prompt: 'Server endpoint',
      placeHolder: 'https://dokploy.example.com',
      validateInput: (value) => {
        try {
          new URL(value);
          return null;
        } catch {
          return 'Please enter a valid URL';
        }
      }
    });
    if (!endpoint) {
      return undefined;
    }

    const apiKey = await vscode.window.showInputBox({
      prompt: 'API key',
      password: true,
      placeHolder: 'Enter your Dokploy API key'
    });
    if (!apiKey) {
      return undefined;
    }

    if (existingServer) {
      const updatedServer: DokployServerConfig = {
        ...existingServer,
        endpoint: endpoint.replace(/\/$/, '')
      };
      await this.updateServer(updatedServer, apiKey);
      return updatedServer;
    }

    const server: DokployServerConfig = {
      id: crypto.randomUUID(),
      name,
      endpoint: endpoint.replace(/\/$/, '')
    };

    await this.addServer(server, apiKey);
    return server;
  }

  async promptSelectServer(): Promise<DokployServerConfig | undefined> {
    const servers = this.getServers();

    if (servers.length === 0) {
      const action = await vscode.window.showInformationMessage(
        'No Dokploy servers configured.',
        'Add Server'
      );
      if (action === 'Add Server') {
        return this.promptAddServer();
      }
      return undefined;
    }

    const items = servers.map(s => ({
      label: s.name,
      description: s.endpoint,
      server: s
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Dokploy server'
    });

    return selected?.server;
  }
}
