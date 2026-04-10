export type JsonObject = Record<string, unknown>;

export interface HttpRequestLike {
  body?: unknown;
  url?: string;
  method?: string;
  setEncoding?: (encoding: string) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface HttpResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

export interface SseClientLike {
  write(frame: string): void;
}

export interface PluginRouteApiLike {
  registerHttpRoute(route: {
    path: string;
    match?: "prefix";
    auth?: string;
    handler: (req: HttpRequestLike, res: HttpResponseLike) => Promise<boolean> | boolean;
  }): void;
}

export interface PreparedStatementLike<TResult = unknown> {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): TResult;
  all(...args: unknown[]): TResult[];
}

export interface DatabaseLike {
  pragma(sql: string): void;
  exec(sql: string): void;
  prepare<TResult = unknown>(sql: string): PreparedStatementLike<TResult>;
  transaction?<TArgs extends unknown[]>(fn: (...args: TArgs) => void): (...args: TArgs) => void;
}
