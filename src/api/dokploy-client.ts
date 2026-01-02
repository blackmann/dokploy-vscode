import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { log } from '../services/logger';
import {
    Application,
    Container,
    Deployment,
    Project
} from '../types/dokploy';

export class DokployClient {
  constructor(
    private endpoint: string,
    private apiKey: string
  ) {}

  async getProjects(): Promise<Project[]> {
    return this.request<Project[]>('/api/project.all');
  }

  async getApplication(applicationId: string): Promise<Application> {
    return this.request<Application>(`/api/application.one?applicationId=${applicationId}`);
  }

  async getDeployments(applicationId: string): Promise<Deployment[]> {
    return this.request<Deployment[]>(`/api/deployment.all?applicationId=${applicationId}`);
  }

  async getDeploymentsByCompose(composeId: string): Promise<Deployment[]> {
    return this.request<Deployment[]>(`/api/deployment.allByCompose?composeId=${composeId}`);
  }

  async deploy(applicationId: string): Promise<void> {
    return this.request('/api/application.deploy', 'POST', { applicationId });
  }

  async redeploy(applicationId: string): Promise<void> {
    return this.request('/api/application.redeploy', 'POST', { applicationId });
  }

  async getContainersByAppLabel(appName: string, type: 'standalone' | 'swarm' = 'standalone'): Promise<Container[]> {
    return this.request<Container[]>(`/api/docker.getContainersByAppLabel?appName=${appName}&type=${type}`);
  }

  getDeploymentLogWsConfig(logPath: string): { url: string; headers: Record<string, string> } {
    const url = new URL(this.endpoint);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return {
      url: `${protocol}//${url.host}/listen-deployment?logPath=${encodeURIComponent(logPath)}`,
      headers: {
        'x-api-key': this.apiKey
      }
    };
  }

  getRuntimeLogWsConfig(containerId: string, tail: number, serverId?: string): { url: string; headers: Record<string, string> } {
    const url = new URL(this.endpoint);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      containerId,
      tail: tail.toString(),
      since: 'all',
      search: '',
      runType: 'native'
    });
    if (serverId) {
      params.set('serverId', serverId);
    }
    return {
      url: `${protocol}//${url.host}/docker-container-logs?${params.toString()}`,
      headers: {
        'x-api-key': this.apiKey
      }
    };
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const url = new URL(path, this.endpoint);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    log(`API Request: ${method} ${url.toString()}`);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          log(`API Response: ${res.statusCode} (${data.length} bytes)`);

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data as unknown as T);
            }
          } else {
            log(`API Error Response: ${data}`);
            reject(new Error(`API request failed: ${res.statusCode} ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        log(`API Request Error:`, error);
        reject(error);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }
}
