// Candidate "open in native navigation" mechanisms (plan §9.1 / Spike 3).
//
// SINGLE SOURCE: build.mjs inlines this into both the car page and
// /nav-benchmark, so the buttons you test are literally the ones that ship.
//
// ON-CAR FINDINGS (XPeng P7+, Xmart OS) — `status` records what the car did:
//   works   — opened and did the useful thing
//   partial — opened an app but did not start navigation
//   fails   — nothing happened
//   untested
//
// What we learned so far:
//  * geo: works, both bare and intent-wrapped. That is a reliable hook.
//  * yandexnavi:// OPENS Yandex Navigator — so contrary to the plan's
//    assumption, Yandex Navigator IS installed on this car. It is the best
//    target for Armenia. It just did not route, which is a parameter or
//    delivery problem, not an availability one.
//  * The AMap intents did nothing, so this head unit is probably not running
//    AMap (or not under the package names tried).
//
// Working theory for the yandexnavi:// miss: Chromium handling a BARE custom
// scheme often launches the app's main activity and drops the path and query.
// The intent:// form carries the full URI, which is why intent→geo worked.
// Hence the intent-wrapped Yandex variants below.
//
// An https:// link can never hand off to a native app — only a scheme or an
// intent:// can. That is why the Yandex web route stays in the browser.

const YANDEX_NAVI_PKG = "ru.yandex.yandexnavi";
const YANDEX_MAPS_PKG = "ru.yandex.yandexmaps";
const AMAP_AUTO_PKG = "com.autonavi.amapauto";

function enc(s) {
  return encodeURIComponent(s || "");
}

function yandexWebRoute(lat, lon) {
  return "https://yandex.com/maps/?rtext=~" + lat + "," + lon + "&rtt=auto";
}

export const NAV_SCHEMES = [
  // --- confirmed working on the car ----------------------------------------
  {
    id: "intentGeo",
    label: "Open in maps (geo intent)",
    status: "works",
    note: "CONFIRMED on the car. Generic geo intent, no package — whatever " +
      "handles maps answers. Shows the point; may not start turn-by-turn.",
    build: function (lat, lon, name) {
      return "intent://" + lat + "," + lon + "?q=" + lat + "," + lon + "(" + enc(name) + ")" +
        "#Intent;scheme=geo;action=android.intent.action.VIEW;end";
    },
  },
  {
    id: "geo",
    label: "Open in maps (geo:)",
    status: "works",
    note: "CONFIRMED on the car. Plain geo: URI, no intent wrapper.",
    build: function (lat, lon, name) {
      return "geo:" + lat + "," + lon + "?q=" + lat + "," + lon + "(" + enc(name) + ")";
    },
  },
  {
    id: "yandexWeb",
    label: "Route in browser (Yandex web)",
    status: "works",
    note: "Opens a route in this browser. No app needed — the safety net.",
    build: function (lat, lon) { return yandexWebRoute(lat, lon); },
  },

  // --- Yandex Navigator: installed, but needs the right delivery ------------
  // These are the highest-value candidates now. Test these first.
  {
    id: "intentYandexNaviRoute",
    label: "① Navigate — Yandex Navigator (intent)",
    status: "untested",
    note: "TOP CANDIDATE. Same route request as the bare scheme that only " +
      "opened the app, but delivered via intent:// with the package, so the " +
      "path and query actually reach the app.",
    build: function (lat, lon) {
      return "intent://build_route_on_map?lat_to=" + lat + "&lon_to=" + lon +
        "#Intent;scheme=yandexnavi;package=" + YANDEX_NAVI_PKG + ";end";
    },
  },
  {
    id: "intentYandexNaviRouteFallback",
    label: "② Navigate — Yandex Navigator (intent + web fallback)",
    status: "untested",
    note: "Same as ①, but falls back to the web route if the app is missing. " +
      "This is the shape to ship if ① works.",
    build: function (lat, lon) {
      return "intent://build_route_on_map?lat_to=" + lat + "&lon_to=" + lon +
        "#Intent;scheme=yandexnavi;package=" + YANDEX_NAVI_PKG +
        ";S.browser_fallback_url=" + enc(yandexWebRoute(lat, lon)) + ";end";
    },
  },
  {
    id: "yandexNaviShowPoint",
    label: "③ Show point — Yandex Navigator (bare)",
    status: "untested",
    note: "Different Navigator verb: drop a pin rather than route. If this " +
      "works where build_route_on_map did not, the verb was the problem.",
    build: function (lat, lon, name) {
      return "yandexnavi://show_point_on_map?lat=" + lat + "&lon=" + lon +
        "&zoom=16&no-balloon=0&desc=" + enc(name);
    },
  },
  {
    id: "intentYandexNaviShowPoint",
    label: "④ Show point — Yandex Navigator (intent)",
    status: "untested",
    note: "The show_point verb delivered via intent://.",
    build: function (lat, lon, name) {
      return "intent://show_point_on_map?lat=" + lat + "&lon=" + lon +
        "&zoom=16&no-balloon=0&desc=" + enc(name) +
        "#Intent;scheme=yandexnavi;package=" + YANDEX_NAVI_PKG + ";end";
    },
  },
  {
    id: "yandexNaviRoute",
    label: "Navigate — Yandex Navigator (bare scheme)",
    status: "partial",
    note: "Opens the app but does NOT start navigation — the query is most " +
      "likely being dropped. Kept as the baseline this round is fixing.",
    build: function (lat, lon) {
      return "yandexnavi://build_route_on_map?lat_to=" + lat + "&lon_to=" + lon;
    },
  },

  // --- Android's standard "start turn-by-turn" request ---------------------
  {
    id: "googleNav",
    label: "⑤ Start navigation (google.navigation:)",
    status: "untested",
    note: "The standard Android request for turn-by-turn. Not Google-specific " +
      "— any navigation app may register for it, and it asks to NAVIGATE " +
      "rather than just show a point, which geo: does not.",
    build: function (lat, lon) {
      return "google.navigation:q=" + lat + "," + lon + "&mode=d";
    },
  },
  {
    id: "intentGoogleNav",
    label: "⑥ Start navigation (google.navigation via intent)",
    status: "untested",
    note: "Same request, intent-delivered.",
    build: function (lat, lon) {
      return "intent://q=" + lat + "," + lon + "&mode=d" +
        "#Intent;scheme=google.navigation;action=android.intent.action.VIEW;end";
    },
  },

  // --- Yandex Maps app (distinct from Navigator) ---------------------------
  {
    id: "intentYandexMaps",
    label: "⑦ Route — Yandex Maps app (intent)",
    status: "untested",
    note: "Yandex Maps is a different app from Navigator and may also be " +
      "installed. Worth one tap.",
    build: function (lat, lon) {
      return "intent://maps.yandex.ru/?rtext=~" + lat + "," + lon + "&rtt=auto" +
        "#Intent;scheme=yandexmaps;package=" + YANDEX_MAPS_PKG + ";end";
    },
  },
  {
    id: "yandexMapsApp",
    label: "Route — Yandex Maps app (bare)",
    status: "untested",
    note: "Bare yandexmaps:// scheme.",
    build: function (lat, lon) {
      return "yandexmaps://maps.yandex.ru/?rtext=~" + lat + "," + lon + "&rtt=auto";
    },
  },

  // --- geo variants, in case the working one only shows a pin --------------
  {
    id: "geoQuery",
    label: "⑧ geo: search form (0,0?q=)",
    status: "untested",
    note: "The other geo form. Some apps route for this one but only pin for " +
      "the other. Try if the working geo: buttons do not start navigation.",
    build: function (lat, lon, name) {
      return "geo:0,0?q=" + lat + "," + lon + "(" + enc(name) + ")";
    },
  },

  // --- AMap: nothing happened on this car ----------------------------------
  {
    id: "intentAmapAutoNavi",
    label: "AMap Auto (intent)",
    status: "fails",
    note: "Did nothing on this car — it probably does not run AMap. Kept so " +
      "the negative result is recorded rather than retried from memory.",
    build: function (lat, lon, name) {
      return "intent://navi?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=0&style=2" +
        "#Intent;scheme=androidamap;package=" + AMAP_AUTO_PKG + ";end";
    },
  },
];
