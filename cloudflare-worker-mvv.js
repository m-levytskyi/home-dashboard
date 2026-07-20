/**
 * Cloudflare Worker als CORS-Proxy für MVV EFA.
 *
 * Erlaubte Endpunkte:
 *   /XML_STOPFINDER_REQUEST
 *   /XML_DM_REQUEST
 *
 * Verwendung im Dashboard:
 * var TRANSPORT_BASE = "https://dein-worker.dein-account.workers.dev";
 */

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { error: "Nur GET-Anfragen sind erlaubt." },
        405
      );
    }

    const allowedPaths = [
      "/XML_STOPFINDER_REQUEST",
      "/XML_DM_REQUEST"
    ];

    if (!allowedPaths.includes(requestUrl.pathname)) {
      return jsonResponse(
        { error: "Dieser Endpunkt ist nicht erlaubt." },
        404
      );
    }

    const upstreamUrl = new URL(
      "https://efa.mvv-muenchen.de/ng" +
      requestUrl.pathname +
      requestUrl.search
    );

    // JSON-Ausgabe erzwingen, falls der Parameter fehlt.
    if (!upstreamUrl.searchParams.has("outputFormat")) {
      upstreamUrl.searchParams.set("outputFormat", "rapidJSON");
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Muenchen-Home-Dashboard/1.0"
        },
        cf: {
          cacheEverything: true,
          cacheTtl: requestUrl.pathname === "/XML_DM_REQUEST" ? 20 : 86400
        }
      });

      const responseBody = await upstreamResponse.arrayBuffer();
      const headers = corsHeaders();

      headers.set(
        "Content-Type",
        upstreamResponse.headers.get("Content-Type") ||
          "application/json; charset=utf-8"
      );

      headers.set(
        "Cache-Control",
        requestUrl.pathname === "/XML_DM_REQUEST"
          ? "public, max-age=20"
          : "public, max-age=86400"
      );

      return new Response(responseBody, {
        status: upstreamResponse.status,
        headers
      });
    } catch (error) {
      return jsonResponse(
        {
          error: "Die MVV-Anfrage ist fehlgeschlagen.",
          detail: String(error)
        },
        502
      );
    }
  }
};

function corsHeaders() {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff"
  });
}

function jsonResponse(data, status = 200) {
  const headers = corsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}
