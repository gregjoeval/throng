import { greet } from "./greeting.js";

export default {
  async fetch(request) {
    const name = new URL(request.url).searchParams.get("name") ?? "world";
    return new Response(greet(name));
  },
};
