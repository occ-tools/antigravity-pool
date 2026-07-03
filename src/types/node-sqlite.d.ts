declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(params?: Record<string, string | number | null>): unknown[];
      get(params?: Record<string, string | number | null>): unknown;
      run(params?: Record<string, string | number | null>): { changes: number };
    };
    close(): void;
  }
}
