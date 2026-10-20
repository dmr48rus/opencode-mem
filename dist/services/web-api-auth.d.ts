export declare function isLoopbackHost(host: string): boolean;
export declare function assertWebServerNetworkAuth(host: string, apiToken?: string, basicAuthEnabled?: boolean): void;
export declare function presentedApiToken(req: Request): string | null;
export declare function isMasterToken(req: Request, apiToken?: string): boolean;
/**
 * Authorize an API request.
 *
 * The master token is the administrator's and keeps full access. A client key
 * carries a scope: a read-only key may read, and is refused anything that
 * changes the store - including the MCP endpoint, whose tools can write.
 */
export declare function authorizeApiRequest(req: Request, apiToken?: string): Response | null;
//# sourceMappingURL=web-api-auth.d.ts.map