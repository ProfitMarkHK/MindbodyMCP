import { mindbodyClient } from "../../../src/api/client.js";

export class Reader {
  private mindbody = mindbodyClient;

  read(path: string) {
    return this.mindbody.get(path);
  }
}
