// A script reading Mindbody with the global fetch, URL hoisted to a constant.
const URL = "https://api.mindbodyonline.com/public/v6/class/classes?Limit=200";

export async function readClasses() {
  return fetch(URL);
}
