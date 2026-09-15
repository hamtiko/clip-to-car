import { describe, it, expect } from "vitest";
import {
  looksLikeMapLink,
  isShortMapLink,
  parseMapLink,
  extractUrl,
  parseBareCoords,
  labelFromText,
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
