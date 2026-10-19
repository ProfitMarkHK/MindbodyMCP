import { fetchAllPages, mindbodyClient as client } from "../../../src/api/client";
// client.get('/class/classes') in a comment is ignored
/* fetchAllPages(client, '/sale/sales', {}, 'Sales') */
export async function forms() {
  const a = await fetchAllPages<any>(
    client,
    "/site/locations",
    {},
    "Locations"
  );
  const b = await client.get<{ X: number }>("/class/classvisits", { params: {} });
  const c = await client
    .get(`/site/activationcode`);
  const d = "https://example.invalid/not-a-comment"; const e = await client.get("/site/sites");
  return [a, b, c, d, e];
}
