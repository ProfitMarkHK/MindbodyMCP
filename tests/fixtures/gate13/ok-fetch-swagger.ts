// The public spec document is not a read of a site, so fetching it is not a call site.
const SPEC_URL = "https://api.mindbodyonline.com/public/v6/swagger/doc";

export async function fetchSpec() {
  return fetch(SPEC_URL);
}
