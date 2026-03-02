/**
 * Feishu API client wrapper.
 * Provides singleton access to the Lark SDK client with connection pooling.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { Config, Credentials } from "../config/schema.js";
import { resolveCredentials } from "../config/schema.js";
import type { ProbeResult } from "../types/index.js";

// ============================================================================
// Client Cache (Singleton Pattern)
// ============================================================================

interface CachedClient {
  client: Lark.Client;
  credentials: Credentials;
}

let cachedClient: CachedClient | null = null;

/**
 * Resolve Lark domain enum from config.
 */
function resolveDomain(domain: "feishu" | "lark"): Lark.Domain {
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/**
 * Create or retrieve the Feishu API client.
 * Uses singleton pattern with credential-based cache invalidation.
 *
 * @throws Error if credentials are not configured
 */
export function getApiClient(config: Config): Lark.Client {
  const credentials = resolveCredentials(config);
  if (!credentials) {
    throw new Error("Feishu credentials not configured (appId, appSecret required)");
  }

  // Return cached client if credentials match
  if (
    cachedClient &&
    cachedClient.credentials.appId === credentials.appId &&
    cachedClient.credentials.appSecret === credentials.appSecret &&
    cachedClient.credentials.domain === credentials.domain
  ) {
    return cachedClient.client;
  }

  // Create new client
  const client = new Lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(credentials.domain),
  });

  cachedClient = { client, credentials };
  return client;
}

/**
 * Create a WebSocket client for real-time events.
 *
 * @throws Error if credentials are not configured
 */
export function createWsClient(config: Config): Lark.WSClient {
  const credentials = resolveCredentials(config);
  if (!credentials) {
    throw new Error("Feishu credentials not configured (appId, appSecret required)");
  }

  return new Lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: resolveDomain(credentials.domain),
    loggerLevel: Lark.LoggerLevel.info,
  });
}



/**
 * Clear the client cache.
 * Useful for testing or when credentials change.
 */
export function clearClientCache(): void {
  cachedClient = null;
}

/**
 * Probe the Feishu API to verify credentials and get bot info.
 */
export async function probeConnection(config: Config | undefined): Promise<ProbeResult> {
  if (!config) {
    return { ok: false, error: "Configuration not provided" };
  }

  const credentials = resolveCredentials(config);
  if (!credentials) {
    return { ok: false, error: "Credentials not configured" };
  }

  try {
    const baseUrl = credentials.domain === "lark"
      ? "https://open.larksuite.com"
      : "https://open.feishu.cn";

    // Probe using direct HTTP for compatibility across SDK versions.
    // Newer @larksuiteoapi/node-sdk builds do not expose `client.bot.*`.
    const tokenResp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      }),
    });

    if (!tokenResp.ok) {
      return {
        ok: false,
        error: `Tenant access token request failed (HTTP ${tokenResp.status})`,
        appId: credentials.appId,
      };
    }

    const tokenJson = (await tokenResp.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
      data?: {
        tenant_access_token?: string;
        expire?: number;
      };
    };

    if (tokenJson.code !== 0) {
      return {
        ok: false,
        error: tokenJson.msg ?? `Failed to obtain tenant access token (code ${tokenJson.code})`,
        appId: credentials.appId,
      };
    }

    const tenantAccessToken =
      tokenJson.tenant_access_token ?? tokenJson.data?.tenant_access_token;

    if (!tenantAccessToken) {
      return {
        ok: false,
        error: "Tenant access token missing in response",
        appId: credentials.appId,
      };
    }

    const infoResp = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });

    if (!infoResp.ok) {
      return {
        ok: false,
        error: `Bot info request failed (HTTP ${infoResp.status})`,
        appId: credentials.appId,
      };
    }

    const infoJson = (await infoResp.json()) as {
      code?: number;
      msg?: string;
      data?: Record<string, unknown>;
    };

    if (infoJson.code !== 0) {
      return {
        ok: false,
        error: infoJson.msg ?? `Bot info API error (code ${infoJson.code})`,
        appId: credentials.appId,
      };
    }

    const data = infoJson.data ?? {};
    const botName = (data["name"] ?? data["app_name"]) as string | undefined;
    const botOpenId =
      (data["open_id"] ?? data["bot_open_id"] ?? data["bot_openId"]) as string | undefined;

    return {
      ok: true,
      appId: credentials.appId,
      botName,
      botOpenId,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      appId: credentials.appId,
    };
  }
}
