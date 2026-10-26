import axios from 'axios';
import { errorMessage } from '../utils/errors.js';

interface TokenResponse {
  TokenType: string;
  AccessToken: string;
  Expires: string; // ISO date string, e.g. "2026-05-31T07:23:45.000Z"
}

interface UserToken {
  token: string;
  expiresAt: Date;
}

/**
 * Thrown when no user token can be had. Requests are never sent without one: a
 * call that falls back to the API key alone is answered with a different data set,
 * so it must fail instead. Marked so the client never retries it (see client.ts).
 */
export class MindbodyAuthError extends Error {
  readonly isAuthError = true;

  constructor(message: string) {
    super(message);
    this.name = 'MindbodyAuthError';
  }
}

/**
 * `SiteId` header from MINDBODY_SITE_ID, omitted when unset/blank. Never send the
 * string "undefined": with no site configured the API key's default applies, and
 * `selectSite` (siteTime.ts) refuses to pick one when the key reaches several.
 */
function siteIdHeader(): Record<string, string> {
  const siteId = process.env.MINDBODY_SITE_ID?.trim();
  return siteId ? { SiteId: siteId } : {};
}

class MindbodyAuth {
  private userToken: UserToken | null = null;
  // Shared by concurrent callers so one expiry issues one token, not one per caller.
  private pendingIssue: Promise<string> | null = null;
  private readonly apiUrl: string;

  constructor() {
    this.apiUrl = process.env.MINDBODY_API_URL || 'https://api.mindbodyonline.com/public/v6';
  }

  private hasSourceCredentials(): boolean {
    return !!(process.env.MINDBODY_SOURCE_NAME && process.env.MINDBODY_SOURCE_PASSWORD);
  }

  /** Returns a valid user token, issuing one if needed. Throws MindbodyAuthError when none can be had. */
  async getUserToken(): Promise<string> {
    if (!this.hasSourceCredentials()) {
      throw new MindbodyAuthError(
        'MINDBODY_SOURCE_NAME and MINDBODY_SOURCE_PASSWORD must be set; refusing to call Mindbody without a user token'
      );
    }

    if (this.userToken && this.userToken.expiresAt > new Date()) {
      return this.userToken.token;
    }

    // A failed issue clears pendingIssue too, so the next call tries again rather than
    // reusing the failure.
    this.pendingIssue ??= this.issueToken().finally(() => {
      this.pendingIssue = null;
    });
    return this.pendingIssue;
  }

  private async issueToken(): Promise<string> {
    try {
      const response = await axios.post<TokenResponse>(
        `${this.apiUrl}/usertoken/issue`,
        {
          Username: process.env.MINDBODY_SOURCE_NAME,
          Password: process.env.MINDBODY_SOURCE_PASSWORD,
        },
        {
          headers: {
            'Api-Key': process.env.MINDBODY_API_KEY!,
            ...siteIdHeader(),
            'Content-Type': 'application/json',
          },
        }
      );

      const expiresAt = response.data.Expires
        ? new Date(new Date(response.data.Expires).getTime() - 60_000)
        : new Date(Date.now() + 23 * 60 * 60 * 1000); // fallback: 23 hours

      this.userToken = {
        token: response.data.AccessToken,
        expiresAt,
      };

      return this.userToken.token;
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const mindbodyMessage = axios.isAxiosError(error) ? error.response?.data?.Error?.Message : undefined;
      const message = typeof mindbodyMessage === 'string' && mindbodyMessage.trim() !== ''
        ? mindbodyMessage
        : errorMessage(error);
      throw new MindbodyAuthError(`Mindbody user token request failed (${status ?? 'no status'}): ${message}`);
    }
  }

  /**
   * Drop the cached token so the next call issues a new one. Called after a 401,
   * in case the token was revoked or expired early.
   */
  resetTokenState(): void {
    this.userToken = null;
  }

  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Api-Key': process.env.MINDBODY_API_KEY!,
      ...siteIdHeader(),
      'Content-Type': 'application/json',
    };

    return headers;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers = this.getHeaders();
    headers['Authorization'] = `Bearer ${await this.getUserToken()}`;
    return headers;
  }
}

export const mindbodyAuth = new MindbodyAuth();
