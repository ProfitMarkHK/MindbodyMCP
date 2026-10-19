// The transport itself: a pager and an HTTP wrapper that forward a caller's path.
export class MindbodyApiClient {
  private client: any;
  async get<T>(endpoint: string): Promise<T> {
    return this.client.get(endpoint);
  }
  async request<T>(config: any): Promise<T> {
    return this.client.request(config);
  }
}

export async function fetchAllPages<T>(client: any, url: string): Promise<T[]> {
  const response = await client.get(url, { params: { Limit: 200, Offset: 0 } });
  return response.Items;
}

export async function activation(client: MindbodyApiClient) {
  return client.get<any>("/site/activationcode");
}
