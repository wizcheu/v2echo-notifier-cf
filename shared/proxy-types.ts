export interface HttpProxyConfig {
  address: string;
  username: string;
  password: string;
}

export interface HttpProxyStatus {
  enabled: boolean;
  configured: boolean;
  encryption_ready: boolean;
  address: string;
  authenticated: boolean;
}

export interface HttpProxyTestResult {
  proxy_address: string;
  ok: boolean;
  http_status: number | null;
  duration_ms: number;
  message: string;
}
