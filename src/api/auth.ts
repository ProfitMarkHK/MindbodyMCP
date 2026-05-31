import axios from 'axios';

interface TokenResponse {
  TokenType: string;
  AccessToken: string;
  Expires: string; // ISO date string, e.g. "2026-05-31T07:23:45.000Z"
}

interface UserToken {
  token: string;
  expiresAt: Date;
}

class MindbodyAuth {
  private userToken: UserToken | null = null;
  private tokenFailed: boolean = false;
  private readonly apiUrl: string;

  constructor() {
    this.apiUrl = process.env.MINDBODY_API_URL || 'https://api.mindbodyonline.com/public/v6';
  }

  private hasSourceCredentials(): boolean {
    return !!(process.env.MINDBODY_SOURCE_NAME && process.env.MINDBODY_SOURCE_PASSWORD);
  }

  async getUserToken(): Promise<string | null> {
    // If we don't have source credentials, skip token auth
    if (!this.hasSourceCredentials()) {
      return null;
    }

    // If token acquisition previously failed, don't keep retrying — restart the server to reset
    if (this.tokenFailed) {
      return null;
    }

    // Check if we have a valid token
    if (this.userToken && this.userToken.expiresAt > new Date()) {
      return this.userToken.token;
    }

    try {
      // Get new token
      const response = await axios.post<TokenResponse>(
        `${this.apiUrl}/usertoken/issue`,
        {
          Username: process.env.MINDBODY_SOURCE_NAME,
          Password: process.env.MINDBODY_SOURCE_PASSWORD,
        },
        {
          headers: {
            'Api-Key': process.env.MINDBODY_API_KEY!,
            'SiteId': process.env.MINDBODY_SITE_ID!,
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

      this.tokenFailed = false;
      return this.userToken.token;
    } catch (error: any) {
      const status = error.response?.status;
      const message = error.response?.data?.Error?.Message || error.message;
      console.error(`User token acquisition failed (${status}): ${message}. Falling back to API-key-only auth.`);
      this.tokenFailed = true;
      return null;
    }
  }

  /**
   * Reset the token failure state so next request retries token acquisition.
   * Useful after credentials are updated or for periodic retry.
   */
  resetTokenState(): void {
    this.tokenFailed = false;
    this.userToken = null;
  }

  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Api-Key': process.env.MINDBODY_API_KEY!,
      'SiteId': process.env.MINDBODY_SITE_ID!,
      'Content-Type': 'application/json',
    };

    return headers;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers = this.getHeaders();
    const token = await this.getUserToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }
}

export const mindbodyAuth = new MindbodyAuth();
