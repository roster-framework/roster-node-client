// Organizationally scoped access descriptors; no provider configuration or credentials.
export type ResourceAccessSpec = {
 id: string; name: string; server_id: string; resource_id: string;
 component: string; route: "proxy"; version: number;
 operations: string[];
};
export type ResourceOperation = { id: string; name: string; tool?: string; arguments?: Record<string, unknown> };
