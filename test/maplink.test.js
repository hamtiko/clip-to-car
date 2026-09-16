import { describe, it, expect } from "vitest";
import {
  looksLikeMapLink,
  isShortMapLink,
  parseMapLink,
  extractUrl,
  parseBareCoords,
  labelFromText,
  parseCoordsFromHtml,
  parseCoordsAll,
  coordHints,
} from "../src/maplink.js";

// The exact string Yandex Maps puts on the share sheet for a dropped pin.
const YANDEX_SHARE = "Կետը քարտեզի վրա 40.204753,44.542365 https://yandex.ru/maps/-/CTxeFV-J";

describe("free-text shares", () => {
  it("pulls lat,lon out of a real Yandex share", () => {
    const c = parseBareCoords(YANDEX_SHARE);
    // Yerevan is ~40.2N 44.5E — latitude FIRST in share text, unlike ll=/pt=.
    expect(c.lat).toBeCloseTo(40.204753, 6);
    expect(c.lon).toBeCloseTo(44.542365, 6);
  });

  it("does not mistake ordinary prose for coordinates", () => {
    expect(parseBareCoords("Apt 12, 34 Main St")).toBeNull();
    expect(parseBareCoords("costs 1.5, 2.5 dollars")).toBeNull(); // too few decimals
    expect(parseBareCoords("no numbers here")).toBeNull();
  });

  it("rejects out-of-range pairs", () => {
    expect(parseBareCoords("200.1234,44.5678")).toBeNull();
  });

  it("extracts an embedded URL and trims trailing punctuation", () => {
    expect(extractUrl(YANDEX_SHARE)).toBe("https://yandex.ru/maps/-/CTxeFV-J");
    expect(extractUrl("see https://example.com/a.")).toBe("https://example.com/a");
    expect(extractUrl("no url here")).toBeNull();
  });

  it("recovers the human label from the share", () => {
    expect(labelFromText(YANDEX_SHARE)).toBe("Կետը քարտեզի վրա");
    expect(labelFromText("https://yandex.ru/maps/-/CTxeFV-J")).toBeNull();
  });
});

describe("looksLikeMapLink", () => {
  it("recognizes Yandex Maps links", () => {
    expect(looksLikeMapLink("https://yandex.com/maps/?ll=44.51,40.17&z=15")).toBe(true);
    expect(looksLikeMapLink("https://yandex.ru/maps/-/CDF123")).toBe(true);
    expect(looksLikeMapLink("https://maps.yandex.com/whatever")).toBe(true);
  });
  it("rejects plain addresses and non-map URLs", () => {
    expect(looksLikeMapLink("Republic Square, Yerevan")).toBe(false);
    expect(looksLikeMapLink("https://example.com/maps")).toBe(false);
    expect(looksLikeMapLink("not a url")).toBe(false);
    expect(looksLikeMapLink("")).toBe(false);
  });
});

describe("isShortMapLink", () => {
  it("flags short /-/ links for redirect expansion", () => {
    expect(isShortMapLink("https://yandex.com/maps/-/CDF123")).toBe(true);
    expect(isShortMapLink("https://yandex.com/maps/?ll=44.5,40.1")).toBe(false);
  });
});

describe("parseMapLink (Yandex lon,lat order)", () => {
  it("parses ll= as lon,lat", () => {
    const p = parseMapLink("https://yandex.com/maps/?ll=44.512600,40.177200&z=17&text=Republic%20Square");
    expect(p.kind).toBe("place");
    expect(p.lat).toBeCloseTo(40.1772, 4);
    expect(p.lon).toBeCloseTo(44.5126, 4);
    expect(p.name).toBe("Republic Square");
  });

  it("prefers whatshere[point] then pt then ll", () => {
    const p = parseMapLink("https://yandex.com/maps/?whatshere%5Bpoint%5D=44.20,40.30&pt=1,2&ll=3,4");
    expect(p.lon).toBeCloseTo(44.2, 4);
    expect(p.lat).toBeCloseTo(40.3, 4);
  });

  it("returns null for an org/place link with no coordinates", () => {
    expect(parseMapLink("https://yandex.com/maps/org/some_place/1234567890/")).toBeNull();
  });

  it("rejects out-of-range coordinates", () => {
    // lat 200 is invalid -> null
    expect(parseMapLink("https://yandex.com/maps/?ll=44.5,200")).toBeNull();
  });

  it("returns null for a non-Yandex URL", () => {
    expect(parseMapLink("https://example.com/?ll=44.5,40.1")).toBeNull();
  });
});


describe("coordinates from a fetched map page", () => {
  // Yerevan: lat ~40.19, lon ~44.51. Every strategy must land on that regardless
  // of the order its own source uses — a swap here puts the pin in another country.
  const LAT = 40.1914, LON = 44.5152;

  it("reads explicit latitude/longitude keys in either order", () => {
    expect(parseCoordsFromHtml('{"latitude":40.1914,"longitude":44.5152}'))
      .toMatchObject({ lat: LAT, lon: LON, via: "latitude/longitude (loose)" });
    expect(parseCoordsFromHtml('{"longitude":44.5152,"latitude":40.1914}'))
      .toMatchObject({ lat: LAT, lon: LON, via: "longitude/latitude (loose)" });
  });

  it("reads a schema.org geo object, which is scoped to the entity", () => {
    expect(parseCoordsFromHtml('{"@type":"Place","geo":{"latitude":40.1914,"longitude":44.5152}}'))
      .toMatchObject({ lat: LAT, lon: LON, via: "geo{} lat,lon" });
  });

  it("reads data-coordinates as lon,lat (real Yandex org page)", () => {
    // Verbatim from a live /maps/org/ page via POST /resolve. Yerevan, so
    // 44.49 is the longitude and 40.20 the latitude — attribute order is lon,lat.
    const html = 'aWQ9OTQ2Mzc0NTE3MTI=" data-coordinates="44.498490,40.200207"><meta itemProp="image"';
    expect(parseCoordsFromHtml(html)).toMatchObject({
      lat: 40.200207, lon: 44.498490, via: "data-coordinates",
    });
  });

  it("reads a Yandex ll= as lon,lat, but only as a last resort", () => {
    // ll= is the map VIEWPORT CENTRE, not the place — usable when nothing
    // better exists, which is why it sorts last and is flagged loose.
    expect(parseCoordsFromHtml('<img src="https://s/?ll=44.5152,40.1914&z=17">'))
      .toMatchObject({ lat: LAT, lon: LON, via: "ll= (map centre, loose)", loose: true });
  });

  it("reads GeoJSON coordinates[] as lon,lat", () => {
    expect(parseCoordsFromHtml('{"coordinates":[44.5152,40.1914]}'))
      .toMatchObject({ lat: LAT, lon: LON, via: "coordinates[]" });
  });

  it("reads geo.position as lat;lon", () => {
    expect(parseCoordsFromHtml('<meta name="geo.position" content="40.1914;44.5152">'))
      .toMatchObject({ lat: LAT, lon: LON, via: "geo.position" });
  });

  // REGRESSION. Org links were resolving to the CITY CENTRE: every extractor
  // took the first pair anywhere in the document, and a map page mentions the
  // city and the viewport centre before the place's own record. The fix is
  // ordering by how tightly a source is bound to the entity, not by how
  // explicit its key names look.
  it("picks the place, not the city centre, when a page mentions both", () => {
    const page =
      '{"city":{"latitude":40.1792,"longitude":44.4991}}' +      // city first...
      '<img src="/s?ll=44.4991,40.1792&z=12">' +                  // ...and the viewport
      '<div data-coordinates="44.498490,40.200207">';             // the actual place
    const got = parseCoordsFromHtml(page);
    expect(got.via).toBe("data-coordinates");
    expect(got.lat).toBeCloseTo(40.200207, 6);
    expect(got.lon).toBeCloseTo(44.498490, 6);
  });

  it("an entity-anchored geo{} beats a loose pair earlier in the page", () => {
    const page =
      '{"region":{"latitude":40.0000,"longitude":44.0000}}' +
      '{"@type":"Place","geo":{"latitude":40.1914,"longitude":44.5152}}';
    expect(parseCoordsFromHtml(page)).toMatchObject({ lat: LAT, lon: LON });
  });

  it("parseCoordsAll surfaces every candidate, flagging the loose ones", () => {
    const page =
      '{"city":{"latitude":40.1792,"longitude":44.4991}}' +
      '<div data-coordinates="44.498490,40.200207">';
    const all = parseCoordsAll(page);
    expect(all.length).toBeGreaterThan(1);
    expect(all[0].via).toBe("data-coordinates"); // priority order
    expect(all[0].loose).toBe(false);
    expect(all.some((c) => c.loose)).toBe(true);
  });

  it("returns null when there is nothing usable", () => {
    expect(parseCoordsFromHtml("<html>no coordinates here</html>")).toBeNull();
    expect(parseCoordsFromHtml("")).toBeNull();
    expect(parseCoordsFromHtml(null)).toBeNull();
  });

  it("rejects out-of-range values rather than guessing", () => {
    expect(parseCoordsFromHtml('{"latitude":991.1111,"longitude":44.5152}')).toBeNull();
  });

  it("coordHints surfaces candidate pairs for eyeballing", () => {
    const hints = coordHints('blah "pos":[44.5152,40.1914] blah');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain("44.5152");
  });
});
