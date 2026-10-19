import axios from "axios";
import { fetchAllPages as pageAll, mindbodyClient as client } from "../../../src/api/client";

export async function stillCaught(dynamicPath: string) {
  await axios.get("/class/classes");
  await client?.get("/class/classes");
  await client
    .get("/class/classes");
  await pageAll(client, "/site/activationcode", {}, "ActivationCode");
  await client.get(dynamicPath);
}
