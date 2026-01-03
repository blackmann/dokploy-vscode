import * as vscode from 'vscode';
import { DokployClient } from '../api/dokploy-client';
import { ConfigService } from '../services/config-service';
import { GitService, RepositoryInfo } from '../services/git-service';
import { log } from '../services/logger';
import { Application, Deployment, DeploymentStatus, Environment, Project } from '../types/dokploy';

type TreeItemType = 'server' | 'environment' | 'application' | 'deployments-folder' | 'deployment' | 'runtime-logs' | 'no-match';

interface MatchedEnvironment {
  environment: Environment;
  applications: Application[];
}

export class DeploymentItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly data?: Application | Deployment | Project | MatchedEnvironment
  ) {
    super(label, collapsibleState);
    this.contextValue = itemType;
  }
}

export class DeploymentsProvider implements vscode.TreeDataProvider<DeploymentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DeploymentItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: DokployClient | undefined;
  private matchedEnvironments: MatchedEnvironment[] = [];
  private repoInfo: RepositoryInfo | undefined;

  constructor(
    private configService: ConfigService,
    private gitService: GitService
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async initialize(): Promise<void> {
    log('Initializing deployments provider...');

    this.client = undefined;
    this.matchedEnvironments = [];

    this.repoInfo = await this.gitService.getRepositoryInfo();
    log('Git repository info:', this.repoInfo);

    const server = this.configService.getActiveServer();
    if (!server) {
      log('No active server configured, skipping initialization');
      this.refresh();
      return;
    }

    log(`Using active server: ${server.name} (${server.endpoint})`);

    const apiKey = await this.configService.getApiKey(server.id);
    if (!apiKey) {
      log(`No API key found for server ${server.name}`);
      this.refresh();
      return;
    }

    log(`API key found for server ${server.name} (length: ${apiKey.length})`);

    const client = new DokployClient(server.endpoint, apiKey);

    try {
      log(`Fetching projects from ${server.endpoint}...`);
      const projects = await client.getProjects();
      log(`Fetched ${projects.length} projects`);

      for (const project of projects) {
        const applications = project.environments.flatMap(env => env.applications)
        log(`Project: ${project.name}`, {
          projectId: project.projectId,
          applicationsCount: applications.length || 0,
        });

        for (const app of applications || []) {
          log(`  Application: ${app.name}`, {
            applicationId: app.applicationId,
            repository: app.repository,
            owner: app.owner,
            branch: app.branch
          });
        }
      }

      const matched = this.findMatchingEnvironments(projects);

      if (matched.length > 0) {
        const totalApps = matched.reduce((sum, env) => sum + env.applications.length, 0);
        log(`Matched ${totalApps} application(s) across ${matched.length} environment(s):`, matched.map(env => ({
          environment: env.environment.name,
          applications: env.applications.map(app => app.name)
        })));
        this.client = client;
        this.matchedEnvironments = matched;
      } else {
        log('No matching application found on this server');
      }
    } catch (error) {
      log(`Error fetching from server ${server.name}:`, error);
    }

    this.refresh();
  }

  private findMatchingEnvironments(projects: Project[]): MatchedEnvironment[] {
    if (!this.repoInfo) {
      log('No repo info available for matching');
      return [];
    }

    log('Searching for matching applications...', {
      localOwner: this.repoInfo.owner,
      localRepo: this.repoInfo.repo
    });

    const matchedEnvs: MatchedEnvironment[] = [];

    for (const project of projects) {
      for (const env of project.environments) {
        const matchedApps: Application[] = [];

        for (const app of env.applications) {
          const matches = this.gitService.matchesRepository(app.repository, app.owner, this.repoInfo);
          if (matches) {
            matchedApps.push(app);
          }
        }

        if (matchedApps.length > 0) {
          matchedEnvs.push({
            environment: env,
            applications: matchedApps
          });
        }
      }
    }

    return matchedEnvs;
  }

  getTreeItem(element: DeploymentItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DeploymentItem): Promise<DeploymentItem[]> {
    if (!element) {
      return this.getRootItems();
    }

    if (element.itemType === 'environment') {
      return this.getEnvironmentChildren(element.data as MatchedEnvironment);
    }

    if (element.itemType === 'application') {
      return this.getApplicationChildren(element.data as Application);
    }

    if (element.itemType === 'deployments-folder') {
      return this.getDeployments(element.data as Application);
    }

    return [];
  }

  private async getRootItems(): Promise<DeploymentItem[]> {
    if (this.matchedEnvironments.length === 0) {
      const item = new DeploymentItem(
        'No matching application found',
        vscode.TreeItemCollapsibleState.None,
        'no-match'
      );
      item.description = 'Click to configure';
      item.command = {
        command: 'dokploy.addServer',
        title: 'Add Server'
      };
      return [item];
    }

    return this.matchedEnvironments.map(matchedEnv => {
      const item = new DeploymentItem(
        matchedEnv.environment.name,
        vscode.TreeItemCollapsibleState.Expanded,
        'environment',
        matchedEnv
      );
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = `${matchedEnv.applications.length} app${matchedEnv.applications.length > 1 ? 's' : ''}`;
      return item;
    });
  }

  private getEnvironmentChildren(matchedEnv: MatchedEnvironment): DeploymentItem[] {
    return matchedEnv.applications.map(app => {
      const item = new DeploymentItem(
        app.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'application',
        app
      );
      item.iconPath = this.getStatusIcon(app.applicationStatus);
      item.description = app.applicationStatus;
      return item;
    });
  }

  private async getApplicationChildren(app: Application): Promise<DeploymentItem[]> {
    const deploymentsFolder = new DeploymentItem(
      'Deployments',
      vscode.TreeItemCollapsibleState.Expanded,
      'deployments-folder',
      app
    );
    deploymentsFolder.iconPath = new vscode.ThemeIcon('folder');

    const runtimeLogs = new DeploymentItem(
      'Runtime Logs',
      vscode.TreeItemCollapsibleState.None,
      'runtime-logs',
      app
    );
    runtimeLogs.iconPath = new vscode.ThemeIcon('terminal');
    runtimeLogs.command = {
      command: 'dokploy.viewRuntimeLogs',
      title: 'View Runtime Logs',
      arguments: [app]
    };

    return [deploymentsFolder, runtimeLogs];
  }

  private async getDeployments(app: Application): Promise<DeploymentItem[]> {
    if (!this.client) {
      return [];
    }

    try {
      const deployments = await this.client.getDeployments(app.applicationId);

      return deployments.slice(0, 15).map(deployment => {
        const item = new DeploymentItem(
          deployment.title || `Deploy ${deployment.deploymentId.slice(0, 8)}`,
          vscode.TreeItemCollapsibleState.None,
          'deployment',
          deployment
        );
        item.description = this.formatDate(deployment.createdAt);
        item.iconPath = this.getDeploymentStatusIcon(deployment.status);
        item.command = {
          command: 'dokploy.viewLogs',
          title: 'View Logs',
          arguments: [deployment]
        };
        return item;
      });
    } catch {
      return [];
    }
  }

  private getStatusIcon(status: string): vscode.ThemeIcon {
    switch (status) {
      case 'running':
        return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
      case 'done':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private getDeploymentStatusIcon(status: DeploymentStatus): vscode.ThemeIcon {
    switch (status) {
      case 'running':
        return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
      case 'done':
        return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return 'just now';
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    return `${diffDays}d ago`;
  }

  getClient(): DokployClient | undefined {
    return this.client;
  }

  getMatchedApplications(): Application[] {
    return this.matchedEnvironments.flatMap(env => env.applications);
  }
}