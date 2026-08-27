const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHooks() {
  const html = fs.readFileSync(
    path.join(__dirname, "index.html"),
    "utf8"
  );
  const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch, "Dashboard script block must exist");

  const window = { __HOME_DASHBOARD_TEST__: true };
  const context = {
    window,
    document: {
      getElementById: function () {
        return { innerHTML: "", style: {} };
      }
    },
    XMLHttpRequest: function () {},
    setInterval: function () {},
    clearInterval: function () {},
    Date,
    Math,
    console
  };

  vm.runInNewContext(scriptMatch[1], context);
  assert.ok(window.__dashboardTestHooks, "Test hooks must be exposed");
  return window.__dashboardTestHooks;
}

function loadWorkerHooks() {
  const source = fs.readFileSync(
    path.join(__dirname, "cloudflare-worker-mvv.js"),
    "utf8"
  ).replace("export default", "const worker =");
  const context = {
    globalThis: {},
    URL,
    Headers,
    Response,
    TextDecoder,
    Uint8Array,
    Date,
    Math,
    fetch: async function () {
      throw new Error("unexpected fetch");
    }
  };

  vm.runInNewContext(
    source +
      "\nglobalThis.__workerTestHooks = {" +
      "roundDownFiveMinutes, radvorFileName, parseRadvorRainAt" +
      "};",
    context
  );
  return context.globalThis.__workerTestHooks;
}

test("extract stop locations and station ids from EFA responses", function () {
  const hooks = loadHooks();
  const response = {
    stopFinder: {
      points: {
        point: [
          { anyType: "Station", extId: "de:09162:100", name: "Münchner Freiheit" },
          { anyType: "STOP", stopId: "de:09162:200", name: "Hauptbahnhof Nord" }
        ]
      }
    }
  };

  const locations = hooks.extractLocations(response);
  assert.equal(locations.length, 2);
  assert.equal(hooks.locationType(locations[0]), "station");
  assert.equal(hooks.locationType(locations[1]), "stop");
  assert.equal(hooks.locationId(locations[0]), "de:09162:100");
  assert.equal(hooks.locationId(locations[1]), "de:09162:200");
});

test("normalize departures keeps line numbers, transport mode and departure times", function () {
  const hooks = loadHooks();
  const rawSubway = {
    servingLine: { name: "U6", class: 2 },
    direction: "Garching-Forschungszentrum",
    plannedWhen: "2026-07-20T10:00:00",
    when: "2026-07-20T10:02:00"
  };
  const rawTram = {
    servingLine: { name: "18", class: 4 },
    direction: "Romanplatz",
    plannedDeparture: { date: "2026-07-20", time: "10:05:00" },
    departure: { date: "2026-07-20", time: "10:05:00" }
  };
  const rawBus = {
    transportation: { number: "56", classId: 5 },
    destination: { name: "Laimer Platz" },
    dateTime: { date: "2026-07-20", time: "10:10:00" },
    realDateTime: { date: "2026-07-20", time: "10:11:00" }
  };

  const subway = hooks.normalizeEFADeparture(rawSubway);
  const tram = hooks.normalizeEFADeparture(rawTram);
  const bus = hooks.normalizeEFADeparture(rawBus);

  assert.equal(hooks.lineName(subway), "U6");
  assert.equal(hooks.lineName(tram), "18");
  assert.equal(hooks.lineName(bus), "56");

  assert.equal(hooks.productMode(subway), "subway");
  assert.equal(hooks.productMode(tram), "tram");
  assert.equal(hooks.productMode(bus), "bus");

  assert.equal(
    hooks.matchesConfig(subway, { mode: "subway", line: "U6" }),
    true
  );
  assert.equal(
    hooks.matchesConfig(tram, { mode: "tram", line: "" }),
    true
  );
  assert.equal(
    hooks.matchesConfig(bus, { mode: "bus", line: "" }),
    true
  );

  assert.equal(
    hooks.departureDate(subway).getTime(),
    new Date("2026-07-20T10:02:00").getTime()
  );
  assert.equal(
    hooks.departureDate(tram).getTime(),
    new Date("2026-07-20T10:05:00").getTime()
  );
  assert.equal(
    hooks.departureDate(bus).getTime(),
    new Date("2026-07-20T10:11:00").getTime()
  );
});

test("transport mode normalization handles ubahn aliases and fallback matching", function () {
  const hooks = loadHooks();
  const ubahnByAlias = hooks.normalizeEFADeparture({
    servingLine: { name: "U 6", trainType: "U-Bahn" },
    plannedWhen: "2026-07-20T10:00:00",
    when: "2026-07-20T10:00:00"
  });
  const unknownModeBusStop = hooks.normalizeEFADeparture({
    servingLine: { name: "56" },
    plannedWhen: "2026-07-20T10:00:00",
    when: "2026-07-20T10:00:00"
  });

  assert.equal(hooks.productMode(ubahnByAlias), "subway");
  assert.equal(
    hooks.matchesConfig(ubahnByAlias, { mode: "subway", line: "U6" }),
    true
  );
  assert.equal(
    hooks.matchesConfig(unknownModeBusStop, { mode: "bus", line: "" }),
    true
  );
});

test("prominent departures select northbound U6 and tram 18", function () {
  const hooks = loadHooks();
  const u6Rule = {
    prominent: {
      line: "U6",
      directions: ["garching", "sendlinger tor"],
      excludedDirections: ["klinikum"]
    }
  };
  const tramRule = { prominent: { line: "18" } };

  assert.equal(hooks.isProminentDeparture({
    line: { name: "U6" },
    direction: "Garching-Forschungszentrum"
  }, u6Rule), true);
  assert.equal(hooks.isProminentDeparture({
    line: { name: "U6" },
    direction: "Sendlinger Tor"
  }, u6Rule), true);
  assert.equal(hooks.isProminentDeparture({
    line: { name: "U6" },
    direction: "Klinikum Großhadern"
  }, u6Rule), false);
  assert.equal(hooks.isProminentDeparture({
    line: { name: "18" },
    direction: "Schwanseestraße"
  }, tramRule), true);
  assert.equal(hooks.isProminentDeparture({
    line: { name: "19" },
    direction: "Berg am Laim"
  }, tramRule), false);
});

test("departure selection keeps the next two future rows across midnight", function () {
  const hooks = loadHooks();
  const now = hooks.parseDateTime("2026-08-27T23:50:00");
  const departures = [
    {
      line: { name: "18", product: "tram" },
      direction: "Past",
      when: "2026-08-27T23:40:00"
    },
    {
      line: { name: "U6", product: "subway" },
      direction: "Wrong mode",
      when: "2026-08-28T00:05:00"
    },
    {
      line: { name: "18", product: "tram" },
      direction: "Second",
      when: "2026-08-28T00:20:00"
    },
    {
      line: { name: "18", product: "tram" },
      direction: "First",
      when: "2026-08-28T00:10:00"
    },
    {
      line: { name: "18", product: "tram" },
      direction: "First",
      when: "2026-08-28T00:10:00"
    }
  ];

  const selected = hooks.selectDepartures(
    departures,
    { mode: "tram", line: "", maximum: 2 },
    now
  );

  assert.equal(selected.length, 2);
  assert.equal(selected[0].direction, "First");
  assert.equal(selected[1].direction, "Second");
});

test("departure requests pin explicit EFA date and time", function () {
  const hooks = loadHooks();
  const startAt = hooks.parseDateTime("2026-08-28T00:00:00");
  const requestUrl = new URL(hooks.departureRequestUrl("de:09162:1554", startAt));

  assert.equal(requestUrl.searchParams.get("name_dm"), "de:09162:1554");
  assert.equal(requestUrl.searchParams.get("limit"), "60");
  assert.equal(requestUrl.searchParams.get("itdDate"), "20260828");
  assert.equal(requestUrl.searchParams.get("itdTime"), "0000");
});

test("extract departures from nested and flat API response shapes", function () {
  const hooks = loadHooks();
  const nested = { departureList: { departure: [{ id: 1 }, { id: 2 }] } };
  const flat = { departures: [{ id: 3 }] };
  const dmPoints = { dm: { points: [{ id: 4 }] } };

  assert.deepEqual(hooks.extractDepartures(nested), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(hooks.extractDepartures(flat), [{ id: 3 }]);
  assert.deepEqual(hooks.extractDepartures(dmPoints), [{ id: 4 }]);
});

test("location id extraction supports nested ref ids", function () {
  const hooks = loadHooks();
  const location = { name: "Laimer Platz", ref: { id: "de:09162:300" } };
  assert.equal(hooks.locationId(location), "de:09162:300");
});

test("weather icon mapping returns stable inline SVG icons", function () {
  const hooks = loadHooks();
  assert.match(hooks.weatherIcon(0), /^<svg[\s\S]*<circle/);
  assert.match(hooks.weatherIcon(3), /^<svg[\s\S]*<path/);
  assert.match(hooks.weatherIcon(61), /M13 30l-2 5/);
  assert.match(hooks.weatherIcon(95), /M21 27l-4 6/);
});

test("rain helpers show near-term probability and next rain today", function () {
  const hooks = loadHooks();
  const now = hooks.parseDateTime("2026-08-27T10:20:00");
  const forecast = {
    hourly: {
      time: [
        "2026-08-27T10:00",
        "2026-08-27T11:00",
        "2026-08-27T12:00",
        "2026-08-27T13:00"
      ],
      precipitation_probability: [5, 60, 70, 20],
      precipitation: [0, 0, 0, 0]
    },
    minutely_15: {
      time: [
        "2026-08-27T10:15",
        "2026-08-27T10:30",
        "2026-08-27T10:45"
      ],
      precipitation: [0.02, 0, 0.06],
      rain: [0, 0, 0]
    }
  };

  assert.equal(
    hooks.formatRainChance(hooks.forecastPercentAt(forecast.hourly, now, 1)),
    "60%"
  );
  assert.equal(
    hooks.formatRainChance(hooks.forecastPercentAt(forecast.hourly, now, 2)),
    "70%"
  );
  assert.equal(
    hooks.formatRainTime(hooks.nextRainToday(forecast, now)),
    "10:45"
  );
});

test("rain status labels distinguish dry, drizzle and rain", function () {
  const hooks = loadHooks();

  assert.equal(hooks.rainStatusLabel(null), "--");
  assert.equal(hooks.rainStatusLabel(0), "trocken");
  assert.equal(hooks.rainStatusLabel(0.04), "Niesel");
  assert.equal(hooks.rainStatusLabel(0.1), "Regen");
  assert.equal(
    hooks.rainAmountFromItem(
      { precipitation: [0.04], rain: [0.2], showers: [0] },
      0
    ),
    0.2
  );
});

test("DWD radar helpers build filenames and decode fixed-grid values", function () {
  const hooks = loadWorkerHooks();

  function radvorFixture(rawValue, flags) {
    const header = Buffer.from(
      "RE270900100000826BY      0VS 5SW  P42001HPR E-03INT  60GP 3x 3VV 000" +
        "\x03",
      "ascii"
    );
    const data = Buffer.alloc(3 * 3 * 2);
    const x = 1;
    const y = 1;
    const width = 3;
    const height = 3;
    const fileRow = height - 1 - y;
    const index = fileRow * width + x;
    data[index * 2] = rawValue & 0xff;
    data[index * 2 + 1] = ((rawValue >> 8) & 0x0f) | flags;
    return Buffer.concat([header, data]);
  }

  assert.equal(
    hooks.roundDownFiveMinutes(
      new Date("2026-08-27T09:07:30Z")
    ).toISOString(),
    "2026-08-27T09:05:00.000Z"
  );
  assert.equal(
    hooks.radvorFileName(new Date("2026-08-27T09:05:00Z"), 5),
    "RE2608270905_005.gz"
  );
  assert.equal(
    Math.round(hooks.parseRadvorRainAt(radvorFixture(1234, 0), 1, 1) * 1000),
    1234
  );
  assert.equal(
    hooks.parseRadvorRainAt(radvorFixture(1234, 0x20), 1, 1),
    0
  );
});

test("light and dark mode controls use SVG instead of emoji glyphs", function () {
  const hooks = loadHooks();
  const moon = hooks.modeIconSVG("moon");
  const sun = hooks.modeIconSVG("sun");

  assert.match(moon, /^<svg[\s\S]*<path/);
  assert.match(sun, /^<svg[\s\S]*<circle/);
  assert.doesNotMatch(moon + sun, /[☀☾]/);
});

test("night mode follows sunrise and sunset", function () {
  const hooks = loadHooks();
  const sunrises = [
    "2026-08-06T05:55",
    "2026-08-07T05:56"
  ];
  const sunsets = [
    "2026-08-06T20:43",
    "2026-08-07T20:41"
  ];

  assert.equal(
    hooks.isNightBySun(new Date("2026-08-06T04:30"), sunrises, sunsets),
    true
  );
  assert.equal(
    hooks.isNightBySun(new Date("2026-08-06T12:00"), sunrises, sunsets),
    false
  );
  assert.equal(
    hooks.isNightBySun(new Date("2026-08-06T21:00"), sunrises, sunsets),
    true
  );
  assert.equal(
    hooks.nextSunTransition(
      new Date("2026-08-06T12:00"),
      sunrises,
      sunsets
    ).getTime(),
    new Date("2026-08-06T20:43").getTime()
  );
});

test("legacy-safe date parser handles Open-Meteo timestamps without seconds", function () {
  const hooks = loadHooks();
  const parsed = hooks.parseDateTime("2026-08-06T05:55");

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 7);
  assert.equal(parsed.getDate(), 6);
  assert.equal(parsed.getHours(), 5);
  assert.equal(parsed.getMinutes(), 55);
});

test("filter Munich public holidays excludes Augsburg Friedensfest", function () {
  const hooks = loadHooks();
  const holidays = [
    {
      startDate: "2026-08-08",
      endDate: "2026-08-08",
      name: [{ language: "DE", text: "Augsburger Friedensfest" }]
    },
    {
      startDate: "2026-10-03",
      endDate: "2026-10-03",
      name: [{ language: "DE", text: "Tag der Deutschen Einheit" }]
    }
  ];

  const filtered = hooks.filterMunichPublicHolidays(holidays);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name[0].text, "Tag der Deutschen Einheit");
});
