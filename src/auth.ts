import * as vscode from "vscode";
import {
  AutolabApi,
  AutolabApiError,
  fetchBufferedResponse,
  parseBufferedJson,
  responseErrorFromBytes,
} from "./api";
import { validateConnectionSettings } from "./config";
import { revokeSession } from "./oauth";
import type { SessionTokens } from "./types";
import { errorMessage, joinHostPath, resolveExternalUrl } from "./utils";

const SESSION_KEY = "autolab.session.v1";
const POLL_INTERVAL_MS = 5_100;

export interface SignOutResult {
  revocationError?: string;
}

export class SessionManager implements vscode.Disposable {
  private refreshPromise: Promise<SessionTokens> | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSession = this.changeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  api(): AutolabApi {
    const settings = validateConnectionSettings();
    return new AutolabApi(settings.host, (forceRefresh) => this.getAccessToken(Boolean(forceRefresh)));
  }

  async hasSession(): Promise<boolean> {
    const settings = validateConnectionSettings();
    const session = await this.readSession();
    return Boolean(session && session.host === settings.host && session.clientId === settings.clientId);
  }

  async signIn(): Promise<void> {
    const settings = validateConnectionSettings();
    const initUrl = new URL(joinHostPath(settings.host, "/oauth/device_flow_init"));
    initUrl.searchParams.set("client_id", settings.clientId);

    const rawInitResponse = await fetchJson(initUrl.toString(), { method: "GET" });
    const initResponse = isRecord(rawInitResponse) ? rawInitResponse : {};
    if (
      typeof initResponse.device_code !== "string"
      || typeof initResponse.user_code !== "string"
      || typeof initResponse.verification_uri !== "string"
    ) {
      throw new Error("Autolab returned an incomplete device authorization response.");
    }
    const deviceCode = initResponse.device_code;
    const userCode = initResponse.user_code;
    const verificationUrl = initResponse.verification_uri;

    const verificationUri = resolveVerificationUri(settings.host, verificationUrl);
    await vscode.env.clipboard.writeText(userCode);
    const choice = await vscode.window.showInformationMessage(
      `Enter code ${userCode} in Autolab. The code is already on your clipboard.`,
      { modal: true, detail: "Sign in only on the Autolab server shown in your browser, then approve the requested permissions." },
      "Open Autolab",
    );
    if (choice !== "Open Autolab") {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(verificationUri));

    const code = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Waiting for Autolab authorization (${userCode})`,
        cancellable: true,
      },
      async (_progress, cancellationToken) => this.pollForCode(
        settings.host,
        settings.clientId,
        deviceCode,
        cancellationToken,
      ),
    );

    if (!code) {
      return;
    }

    const tokens = await this.exchangeToken(settings.host, settings.clientId, {
      grant_type: "authorization_code",
      client_id: settings.clientId,
      redirect_uri: joinHostPath(settings.host, "/device_flow_auth_cb"),
      code,
    });
    await this.storeSession(tokens);
    this.changeEmitter.fire();
  }

  async signOut(): Promise<SignOutResult> {
    const session = await this.readSession();
    let revocationError: string | undefined;
    if (session) {
      try {
        await revokeSession(session);
      } catch (error) {
        revocationError = errorMessage(error);
      }
    }
    await this.secrets.delete(SESSION_KEY);
    this.changeEmitter.fire();
    return { revocationError };
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const settings = validateConnectionSettings();
    const session = await this.readSession();
    if (!session || session.host !== settings.host || session.clientId !== settings.clientId) {
      throw new Error("Sign in to Autolab first.");
    }

    if (!forceRefresh && session.expiresAt > Date.now() + 60_000) {
      return session.accessToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshSession(session).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return (await this.refreshPromise).accessToken;
  }

  private async refreshSession(session: SessionTokens): Promise<SessionTokens> {
    try {
      const refreshed = await this.exchangeToken(session.host, session.clientId, {
        grant_type: "refresh_token",
        client_id: session.clientId,
        refresh_token: session.refreshToken,
      });
      await this.storeSession(refreshed);
      this.changeEmitter.fire();
      return refreshed;
    } catch (error) {
      if (error instanceof AutolabApiError && [400, 401].includes(error.status)) {
        await this.secrets.delete(SESSION_KEY);
        this.changeEmitter.fire();
        throw new Error("Your Autolab session expired or was revoked. Sign in again.");
      }
      throw error;
    }
  }

  private async pollForCode(
    host: string,
    clientId: string,
    deviceCode: string,
    cancellationToken: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const deadline = Date.now() + 10 * 60_000;
    while (!cancellationToken.isCancellationRequested && Date.now() < deadline) {
      const url = new URL(joinHostPath(host, "/oauth/device_flow_authorize"));
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("device_code", deviceCode);

      const { response, data } = await fetchBufferedResponse(url.toString(), { method: "GET" });
      if (response.ok) {
        const value = parseBufferedJson(data);
        const code = isRecord(value) && typeof value.code === "string" ? value.code : undefined;
        if (!code) {
          throw new Error("Autolab approved the request but did not return an authorization code.");
        }
        return code;
      }

      const apiError = responseErrorFromBytes(response, data);
      if (apiError.code !== "authorization_pending" && apiError.message !== "authorization_pending" && response.status !== 429) {
        throw apiError;
      }
      await cancellableDelay(POLL_INTERVAL_MS, cancellationToken);
    }

    if (!cancellationToken.isCancellationRequested) {
      throw new Error("Autolab sign-in timed out. Start sign-in again to get a new code.");
    }
    return undefined;
  }

  private async exchangeToken(host: string, clientId: string, parameters: Record<string, string>): Promise<SessionTokens> {
    const body = new URLSearchParams(parameters);
    let response: Response;
    let responseData: Uint8Array;
    try {
      const result = await fetchBufferedResponse(joinHostPath(host, "/oauth/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body,
      });
      response = result.response;
      responseData = result.data;
    } catch (error) {
      throw new Error(`Could not reach Autolab: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      const apiError = responseErrorFromBytes(response, responseData);
      if (apiError.code === "invalid_client" || /client/i.test(apiError.message)) {
        throw new Error(
          "Autolab rejected this public client. Ask the administrator to register the API application as non-confidential (confidential: false); do not distribute its client secret.",
        );
      }
      throw apiError;
    }

    const parsed = parseBufferedJson(responseData);
    const value = isRecord(parsed) ? parsed : {};
    if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string") {
      throw new Error("Autolab did not return the expected access and refresh tokens.");
    }
    const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
      ? value.expires_in
      : 7_200;
    return {
      host,
      clientId,
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000,
    };
  }

  private async readSession(): Promise<SessionTokens | undefined> {
    const raw = await this.secrets.get(SESSION_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as SessionTokens;
    } catch {
      await this.secrets.delete(SESSION_KEY);
      return undefined;
    }
  }

  private async storeSession(session: SessionTokens): Promise<void> {
    await this.secrets.store(SESSION_KEY, JSON.stringify(session));
  }
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  let data: Uint8Array;
  try {
    const result = await fetchBufferedResponse(url, init);
    response = result.response;
    data = result.data;
  } catch (error) {
    throw new Error(`Could not reach Autolab: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw responseErrorFromBytes(response, data);
  }
  return parseBufferedJson(data);
}

function resolveVerificationUri(host: string, verificationUri: string): string {
  return resolveExternalUrl(host, verificationUri, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cancellableDelay(milliseconds: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    let subscription: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      subscription?.dispose();
      resolve();
    }, milliseconds);
    subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription?.dispose();
      resolve();
    });
  });
}
