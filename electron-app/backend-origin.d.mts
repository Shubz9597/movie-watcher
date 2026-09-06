export declare const DEFAULT_BACKEND_ORIGIN: string;
export declare function resolveBackendOrigin(env?: {
  BACKEND_URL?: string | null;
  VITE_TORWATCH_BACKEND_URL?: string | null;
} | undefined): string;
