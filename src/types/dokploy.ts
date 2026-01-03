export interface DokployServerConfig {
  id: string;
  name: string;
  endpoint: string;
}

export interface Environment {
  environmentId: string;
  name: string;
  applications: Application[];
}

export interface Project {
  projectId: string;
  name: string;
  description?: string;
  createdAt: string;
  environments: Environment[];
  compose: Compose[];
}

export interface Application {
  applicationId: string;
  name: string;
  appName: string;
  description?: string;
  applicationStatus: ApplicationStatus;
  createdAt: string;
  repository?: string;
  owner?: string;
  branch?: string;
  buildPath?: string;
  domains?: Domain[];
  projectId: string;
  environmentId?: string;
  serverId?: string;
}

export type ApplicationStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'error';

export interface Compose {
  composeId: string;
  name: string;
  appName: string;
  description?: string;
  composeStatus: ApplicationStatus;
  createdAt: string;
  projectId: string;
}

export interface Deployment {
  deploymentId: string;
  title?: string;
  description?: string;
  status: DeploymentStatus;
  logPath: string;
  createdAt: string;
  applicationId?: string;
  composeId?: string;
}

export type DeploymentStatus =
  | 'running'
  | 'done'
  | 'error';

export interface Domain {
  domainId: string;
  host: string;
  port?: number;
  https: boolean;
  certificateType?: string;
}

export interface Container {
  containerId: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface ApiError {
  message: string;
  code?: string;
  issues?: string[];
}
