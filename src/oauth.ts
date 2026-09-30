import { responseError } from "./api";
import type { SessionTokens } from "./types";
import { errorMessage, joinHostPath } from "./utils";

export async function revokeSession(session: SessionTokens): Promise<void> {
  const body = new URLSearchParams({
    client_id: session.clientId,
    token: session.refreshToken,
    token_type_hint: "refresh_token",
  });

  let response: Response;
  try {
    response = await fetch(joinHostPath(session.host, "/oauth/revoke"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body,
    });
  } catch (error) {
    throw new Error(`Could not reach Autolab to revoke the session: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw await responseError(response);
  }
}
