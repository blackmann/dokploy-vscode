import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from './logger';

const execAsync = promisify(exec);

export interface RepositoryInfo {
  owner: string;
  repo: string;
  url: string;
}

export class GitService {
  async getRepositoryInfo(): Promise<RepositoryInfo | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      log('No workspace folders found');
      return undefined;
    }

    const cwd = workspaceFolders[0].uri.fsPath;
    log(`Workspace folder: ${cwd}`);

    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd });
      const url = stdout.trim();
      log(`Git remote URL: ${url}`);
      const result = this.parseRemoteUrl(url);
      log('Parsed repository info:', result);
      return result;
    } catch (error) {
      log('Failed to get git remote:', error);
      return undefined;
    }
  }

  private parseRemoteUrl(url: string): RepositoryInfo | undefined {
    const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        owner: sshMatch[2],
        repo: sshMatch[3],
        url
      };
    }

    const httpsMatch = url.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2],
        url
      };
    }

    return undefined;
  }

  matchesRepository(appRepo: string | undefined, appOwner: string | undefined, repoInfo: RepositoryInfo): boolean {
    if (!appRepo || !appOwner) {
      return false;
    }

    const normalizedAppRepo = appRepo.replace(/\.git$/, '').toLowerCase();
    const normalizedRepo = repoInfo.repo.toLowerCase();
    const normalizedAppOwner = appOwner.toLowerCase();
    const normalizedOwner = repoInfo.owner.toLowerCase();

    return normalizedAppRepo === normalizedRepo && normalizedAppOwner === normalizedOwner;
  }
}
