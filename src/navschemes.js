// Candidate "open in native navigation" mechanisms (plan §9.1 / Spike 3).
//
// SINGLE SOURCE: build.mjs inlines this into both the car page and
// /nav-benchmark, so the buttons you test are literally the ones that ship.
//
// Background, because this is the crux of the whole feature:
//
//  * An https:// link can only ever open a web page. It will never hand off to
//    a native app. That is why "Open route (Yandex web)" stays in the browser.
//  * A bare custom scheme (androidamap://…) often does nothing when used as an
//    <a href> from a page — Chromium blocks or ignores unknown schemes.
//  * On Android/Chromium the documented, reliable mechanism is intent:// with a
//    package name, and it supports S.browser_fallback_url so an uninstalled app
//    degrades to a web page instead of failing silently.
//
// The XPeng runs Xmart OS (Android) with AMap/Gaode built in. Head units ship
// AMap Auto (com.autonavi.amapauto), which is a DIFFERENT package from the
// phone app (com.autonavi.minimap) — both are listed here because we do not
// know which this car has.
//
// `dev` is AMap's datum flag: dev=0 says the coordinates are already in AMap's
// GCJ-02 space, dev=1 says they are raw GPS (WGS-84) and should be offset.
// Outside China no offset should apply, so dev=0 is the likely-correct one —
// but that is a guess until the car says otherwise, hence both.

const AMAP_PHONE_PKG = "com.autonavi.minimap";
const AMAP_AUTO_PKG = "com.autonavi.amapauto";

function enc(s) {
  return encodeURIComponent(s || "");
}

// Yandex web route — no app needed, always opens something. Used as the
// fallback target for the intent:// variants.
function yandexWebRoute(lat, lon) {
  return "https://yandex.com/maps/?rtext=~" + lat + "," + lon + "&rtt=auto";
}

export const NAV_SCHEMES = [
  // --- browser fallbacks: guaranteed to open, no app required ---------------
  {
    id: "yandexWeb",
    label: "Yandex web route",
    note: "Opens a route in this browser. No app. Always works — the safety net.",
    build: function (lat, lon) { return yandexWebRoute(lat, lon); },
  },
  {
    id: "yandexWebPin",
    label: "Yandex web pin",
    note: "Drops a pin in this browser instead of routing.",
    build: function (lat, lon) {
      return "https://yandex.com/maps/?whatshere%5Bpoint%5D=" + lon + "," + lat + "&whatshere%5Bzoom%5D=17";
    },
  },

  // --- Android intent:// — the mechanism most likely to hand off natively ---
  {
    id: "intentAmapAutoNavi",
    label: "intent → AMap Auto (navi, dev=0)",
    note: "Head-unit AMap via intent. Most likely candidate on a car.",
    build: function (lat, lon, name) {
      return "intent://navi?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=0&style=2" +
        "#Intent;scheme=androidamap;package=" + AMAP_AUTO_PKG + ";end";
    },
  },
  {
    id: "intentAmapAutoRoute",
    label: "intent → AMap Auto (route plan, dev=0)",
    note: "Head-unit AMap route planner via intent.",
    build: function (lat, lon, name) {
      return "intent://route/plan/?sourceApplication=clip-to-car&dlat=" + lat +
        "&dlon=" + lon + "&dname=" + enc(name) + "&dev=0&t=0" +
        "#Intent;scheme=amapuri;package=" + AMAP_AUTO_PKG + ";end";
    },
  },
  {
    id: "intentAmapPhoneNavi",
    label: "intent → AMap phone app (navi, dev=0)",
    note: "Same, but the phone-app package. Try if the Auto one does nothing.",
    build: function (lat, lon, name) {
      return "intent://navi?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=0&style=2" +
        "#Intent;scheme=androidamap;package=" + AMAP_PHONE_PKG + ";end";
    },
  },
  {
    id: "intentAmapAutoNaviDev1",
    label: "intent → AMap Auto (navi, dev=1)",
    note: "Datum check: if dev=0 lands the pin in the wrong place, try this.",
    build: function (lat, lon, name) {
      return "intent://navi?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=1&style=2" +
        "#Intent;scheme=androidamap;package=" + AMAP_AUTO_PKG + ";end";
    },
  },
  {
    id: "intentAmapFallback",
    label: "intent → AMap, web fallback",
    note: "Opens AMap if present, otherwise falls back to the Yandex web route. " +
      "The best shape for production once a package name is confirmed.",
    build: function (lat, lon, name) {
      return "intent://navi?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=0&style=2" +
        "#Intent;scheme=androidamap;package=" + AMAP_AUTO_PKG +
        ";S.browser_fallback_url=" + enc(yandexWebRoute(lat, lon)) + ";end";
    },
  },
  {
    id: "intentGeo",
    label: "intent → geo (any map app)",
    note: "Generic geo intent, no package. Whatever handles maps should answer.",
    build: function (lat, lon, name) {
      return "intent://" + lat + "," + lon + "?q=" + lat + "," + lon + "(" + enc(name) + ")" +
        "#Intent;scheme=geo;action=android.intent.action.VIEW;end";
    },
  },

  // --- bare custom schemes: may be ignored by the browser -------------------
  {
    id: "amapNavi",
    label: "androidamap:// (navi, dev=0)",
    note: "Bare scheme, no intent wrapper. Often silently ignored by Chromium.",
    build: function (lat, lon, name) {
      return "androidamap://navi?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=0&style=2";
    },
  },
  {
    id: "amapViewMap",
    label: "androidamap:// (viewMap)",
    note: "Show the point rather than route to it.",
    build: function (lat, lon, name) {
      return "androidamap://viewMap?sourceApplication=clip-to-car&poiname=" + enc(name) +
        "&lat=" + lat + "&lon=" + lon + "&dev=0";
    },
  },
  {
    id: "amapUriRoute",
    label: "amapuri:// (route plan, dev=0)",
    note: "Bare amapuri scheme.",
    build: function (lat, lon, name) {
      return "amapuri://route/plan/?sourceApplication=clip-to-car&dlat=" + lat +
        "&dlon=" + lon + "&dname=" + enc(name) + "&dev=0&t=0";
    },
  },
  {
    id: "geo",
    label: "geo: (bare)",
    note: "Plain geo: URI with no intent wrapper.",
    build: function (lat, lon, name) {
      return "geo:" + lat + "," + lon + "?q=" + lat + "," + lon + "(" + enc(name) + ")";
    },
  },
  {
    id: "baidu",
    label: "baidumap://",
    note: "Only if this car ships Baidu rather than AMap. Unlikely; cheap to check.",
    build: function (lat, lon, name) {
      return "baidumap://map/direction?destination=" + lat + "," + lon +
        "&destination_name=" + enc(name) + "&mode=driving&coord_type=wgs84";
    },
  },
  {
    id: "yandexNavi",
    label: "yandexnavi:// (expected to fail)",
    note: "Yandex Navigator is not installable on a China-spec car. Confirms " +
      "what a dead scheme looks like on this browser — useful as a control.",
    build: function (lat, lon) {
      return "yandexnavi://build_route_on_map?lat_to=" + lat + "&lon_to=" + lon;
    },
  },
];
