const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadHooks() {
  const html = fs.readFileSync(
    "/home/runner/work/home-dashboard/home-dashboard/index.html",
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

test("extract stop locations and station ids from EFA responses", function () {
  const hooks = loadHooks();
  const response = {
    stopFinder: {
      points: {
        point: [
          { anyType: "Station", extId: "de:09162:100", name: "Haderner Stern" },
          { anyType: "STOP", stopId: "de:09162:200", name: "Gondrellplatz" }
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
    destination: { name: "Stiftsbogen" },
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

test("extract departures from nested and flat API response shapes", function () {
  const hooks = loadHooks();
  const nested = { departureList: { departure: [{ id: 1 }, { id: 2 }] } };
  const flat = { departures: [{ id: 3 }] };

  assert.deepEqual(hooks.extractDepartures(nested), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(hooks.extractDepartures(flat), [{ id: 3 }]);
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
