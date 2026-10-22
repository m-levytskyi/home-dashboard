/**
 * Cloudflare Worker als CORS-Proxy für MVV EFA.
 *
 * Erlaubte Endpunkte:
 *   /XML_STOPFINDER_REQUEST
 *   /XML_DM_REQUEST
 *   /weather
 *   /dwd-rain
 *   /holidays/public
 *   /holidays/school
 *   /arena/home-matches
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

    if (requestUrl.pathname === "/weather") {
      return proxyWeather(requestUrl);
    }

    if (requestUrl.pathname === "/dwd-rain") {
      return proxyDwdRain();
    }

    if (requestUrl.pathname === "/holidays/public") {
      return proxyHolidays(requestUrl, "PublicHolidays");
    }

    if (requestUrl.pathname === "/holidays/school") {
      return proxyHolidays(requestUrl, "SchoolHolidays");
    }

    if (requestUrl.pathname === "/arena/home-matches") {
      return proxyArenaHomeMatches();
    }

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

const DWD_RADVOR_BASE = "https://opendata.dwd.de/weather/radar/radvor/re/";
const DWD_RADAR_X = 641;
const DWD_RADAR_Y = 789;
const DWD_RADAR_RAIN_THRESHOLD = 0.05;
const DWD_RADAR_LOOKBACK_STEPS = 12;

async function proxyWeather(requestUrl) {
  const upstreamUrl = new URL("https://api.open-meteo.com/v1/forecast");
  upstreamUrl.search = requestUrl.search;

  try {
    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      headers: { "Accept": "application/json" },
      cf: { cacheEverything: true, cacheTtl: 600 }
    });
    const responseBody = await upstreamResponse.arrayBuffer();
    const headers = corsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=600");

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers
    });
  } catch (error) {
    return jsonResponse(
      { error: "Die Wetteranfrage ist fehlgeschlagen.", detail: String(error) },
      502
    );
  }
}

async function proxyDwdRain() {
  const rounded = roundDownFiveMinutes(new Date());

  for (let i = 0; i <= DWD_RADAR_LOOKBACK_STEPS; i += 1) {
    const run = new Date(rounded.getTime() - i * 300000);
    const fileName = radvorFileName(run, 0);
    const buffer = await fetchRadvorFrame(fileName);
    if (!buffer) continue;

    const rainMm = parseRadvorRainAt(buffer);
    if (rainMm === null) continue;

    return jsonResponse(
      {
        source: "DWD RADVOR RE",
        run: run.toISOString(),
        file: fileName,
        rainMm: Math.round(rainMm * 1000) / 1000,
        rainNow: rainMm >= DWD_RADAR_RAIN_THRESHOLD
      },
      200,
      240
    );
  }

  return jsonResponse(
    { error: "Keine DWD-Radardaten verfügbar." },
    502,
    60
  );
}

async function fetchRadvorFrame(fileName) {
  try {
    const upstreamResponse = await fetch(DWD_RADVOR_BASE + fileName, {
      headers: {
        "Accept": "application/gzip, application/octet-stream, */*"
      },
      cf: { cacheEverything: true, cacheTtl: 240 }
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) return null;

    const stream = upstreamResponse.body.pipeThrough(
      new DecompressionStream("gzip")
    );
    return await new Response(stream).arrayBuffer();
  } catch (error) {
    return null;
  }
}

function roundDownFiveMinutes(date) {
  const rounded = new Date(date.getTime());
  rounded.setUTCSeconds(0, 0);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / 5) * 5);
  return rounded;
}

function radvorFileName(date, leadMinutes = 0) {
  return "RE" +
    twoDigit(date.getUTCFullYear() % 100) +
    twoDigit(date.getUTCMonth() + 1) +
    twoDigit(date.getUTCDate()) +
    twoDigit(date.getUTCHours()) +
    twoDigit(date.getUTCMinutes()) +
    "_" +
    String(leadMinutes).padStart(3, "0") +
    ".gz";
}

function twoDigit(number) {
  return String(number).padStart(2, "0");
}

function parseRadvorRainAt(buffer, x = DWD_RADAR_X, y = DWD_RADAR_Y) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let headerEnd = -1;

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 3) {
      headerEnd = i;
      break;
    }
  }

  if (headerEnd < 0) return null;

  const header = new TextDecoder("ascii").decode(bytes.slice(0, headerEnd));
  const gridMatch = /GP\s*(\d+)\s*x\s*(\d+)/.exec(header);
  const precisionMatch = /PR\s+E([+-]?\d+)/.exec(header);
  const width = gridMatch ? Number(gridMatch[1]) : 900;
  const height = gridMatch ? Number(gridMatch[2]) : 900;
  const precision = precisionMatch ?
    Math.pow(10, Number(precisionMatch[1])) : 1;

  if (x < 0 || y < 0 || x >= width || y >= height) return null;

  const fileRow = height - 1 - y;
  const offset = headerEnd + 1 + (fileRow * width + x) * 2;
  if (offset + 1 >= bytes.length) return null;

  const lowByte = bytes[offset];
  const highByte = bytes[offset + 1];
  if (highByte & 0x20) return 0;

  let value = lowByte | ((highByte & 0x0f) << 8);
  if (highByte & 0x40) value = -value;

  return Math.max(0, value * precision);
}

async function proxyHolidays(requestUrl, endpoint) {
  const upstreamUrl = new URL(
    "https://openholidaysapi.org/" + endpoint
  );
  upstreamUrl.search = requestUrl.search;

  try {
    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      headers: { "Accept": "application/json" },
      cf: { cacheEverything: true, cacheTtl: 21600 }
    });
    const responseBody = await upstreamResponse.arrayBuffer();
    const headers = corsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=21600");

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers
    });
  } catch (error) {
    return jsonResponse(
      { error: "Die Feiertagsanfrage ist fehlgeschlagen.", detail: String(error) },
      502
    );
  }
}

const FCB_CALENDAR_URL =
  "https://i.cal.to/ical/2/fcbayern/spielplan/12345.12345-54321.ics";

async function proxyArenaHomeMatches() {
  try {
    const response = await fetch(FCB_CALENDAR_URL, {
      headers: { "Accept": "text/calendar" },
      cf: { cacheEverything: true, cacheTtl: 300 }
    });
    if (!response.ok) throw new Error("Kalender antwortet mit " + response.status);
    return jsonResponse(parseFcbHomeEvents(await response.text()), 200, 300);
  } catch (error) {
    return jsonResponse(
      { error: "Der FC-Bayern-Spielplan ist nicht verfügbar.", detail: String(error) },
      502,
      60
    );
  }
}

// shortcut: handles the FC Bayern calovo ICS subset; revisit if that feed changes format.
function parseFcbHomeEvents(ics) {
  const lines = String(ics).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let event = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      event = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (event && event.location && event.location.indexOf("Allianz Arena") !== -1 &&
          event.date && event.title && event.status !== "CANCELLED") {
        events.push(event);
      }
      event = null;
      continue;
    }
    if (!event) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(";")[0];
    const value = line.slice(colon + 1).replace(/\\([nN,;\\])/g, function (_, char) {
      return char === "n" || char === "N" ? " " : char;
    });

    if (key === "DTSTART") {
      const dateTime = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}Z?)?$/.exec(value);
      if (dateTime) {
        event.date = dateTime[1] + "-" + dateTime[2] + "-" + dateTime[3];
        if (dateTime[4]) event.time = dateTime[4] + ":" + dateTime[5];
      }
    } else if (key === "LOCATION") event.location = value;
    else if (key === "SUMMARY") event.title = value.replace(/^\*/, "");
    else if (key === "STATUS") event.status = value;
  }

  return events;
}

function corsHeaders() {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff"
  });
}

function jsonResponse(data, status = 200, cacheSeconds = null) {
  const headers = corsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (cacheSeconds !== null) {
    headers.set("Cache-Control", "public, max-age=" + cacheSeconds);
  }

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}
