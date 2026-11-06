// Cloudflare Pages: the front end is served as static files; /api/* goes to the API Worker through a service
// binding (see _routes.json and deploy/pages/wrangler.jsonc).
export default {
  fetch(request, env) {
    return new URL(request.url).pathname.startsWith("/api/") ? env.API.fetch(request) : env.ASSETS.fetch(request);
  },
};
