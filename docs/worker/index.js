// platformcosmo.io edge worker: serves the built VitePress site unchanged and records one
// Workers Analytics Engine data point per HTML page view (dataset `platformcosmo`).
//
// Privacy: no cookies, no IP address, no user-agent string, nothing stored on the client.
// Recorded per page view: host (index), path, referrer host, country (from Cloudflare's edge
// metadata) and HTTP status. Failures to record never affect the response.
/* global URL -- Workers runtime global */
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    try {
      recordPageView(request, response, env.analytics_engine);
    } catch {
      // analytics must never break the site
    }
    return response;
  },
};

function recordPageView(request, response, dataset) {
  if (!dataset || request.method !== "GET") return;
  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("text/html")) return;
  const url = new URL(request.url);
  dataset.writeDataPoint({
    indexes: [url.hostname],
    blobs: [
      url.pathname.slice(0, 256),
      referrerHost(request.headers.get("referer")),
      String((request.cf && request.cf.country) || ""),
      String(response.status),
    ],
    doubles: [1],
  });
}

function referrerHost(referer) {
  if (!referer) return "";
  try {
    return new URL(referer).hostname.slice(0, 128);
  } catch {
    return "";
  }
}
