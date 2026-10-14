import { describe, expect, it } from "vitest";
import {
  appendDurationToFirstLine,
  bucketElapsedMs,
  formatDuration,
  formatDurationOverHours,
} from "../../../src/app/formatters/duration-formatter.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("app/formatters/duration-formatter", () => {
  it("puts the duration on the first line of a message that lists several", () => {
    expect(appendDurationToFirstLine("one", "21s")).toBe("one · 🕒 21s");
    expect(appendDurationToFirstLine("one\ntwo", "21s")).toBe("one · 🕒 21s\ntwo");
  });

  describe("formatDuration", () => {
    it("renders sub-minute durations as seconds", () => {
      expect(formatDuration(20 * SECOND)).toBe("20s");
      expect(formatDuration(59 * SECOND)).toBe("59s");
    });

    it("renders whole minutes without a seconds part", () => {
      expect(formatDuration(MINUTE)).toBe("1m");
      expect(formatDuration(5 * MINUTE)).toBe("5m");
    });

    it("renders minutes with seconds when seconds are not zero", () => {
      expect(formatDuration(MINUTE + 3 * SECOND)).toBe("1m 3s");
    });

    it("renders whole hours without smaller parts", () => {
      expect(formatDuration(HOUR)).toBe("1h");
      expect(formatDuration(24 * HOUR)).toBe("24h");
    });

    it("renders hours with minutes and seconds when they are not zero", () => {
      expect(formatDuration(HOUR + 15 * MINUTE)).toBe("1h 15m");
      expect(formatDuration(HOUR + 2 * MINUTE + 3 * SECOND)).toBe("1h 2m 3s");
    });

    it("treats zero and invalid input as zero seconds", () => {
      expect(formatDuration(0)).toBe("0s");
      expect(formatDuration(-5)).toBe("0s");
    });
  });

  describe("formatDurationOverHours", () => {
    it("renders the tracking cap in the same notation", () => {
      expect(formatDurationOverHours(24)).toBe(">24h");
    });
  });

  describe("bucketElapsedMs", () => {
    it("rounds down to ten seconds below a minute", () => {
      expect(bucketElapsedMs(20 * SECOND)).toBe(20 * SECOND);
      expect(bucketElapsedMs(29 * SECOND)).toBe(20 * SECOND);
      expect(bucketElapsedMs(59 * SECOND)).toBe(50 * SECOND);
    });

    it("rounds down to whole minutes below ten minutes", () => {
      expect(bucketElapsedMs(MINUTE)).toBe(MINUTE);
      expect(bucketElapsedMs(9 * MINUTE + 59 * SECOND)).toBe(9 * MINUTE);
    });

    it("rounds down to five minutes below an hour", () => {
      expect(bucketElapsedMs(10 * MINUTE)).toBe(10 * MINUTE);
      expect(bucketElapsedMs(14 * MINUTE)).toBe(10 * MINUTE);
      expect(bucketElapsedMs(59 * MINUTE)).toBe(55 * MINUTE);
    });

    it("rounds down to fifteen minutes from an hour onwards", () => {
      expect(bucketElapsedMs(HOUR)).toBe(HOUR);
      expect(bucketElapsedMs(HOUR + 20 * MINUTE)).toBe(HOUR + 15 * MINUTE);
    });

    it("returns zero for non-positive input", () => {
      expect(bucketElapsedMs(0)).toBe(0);
      expect(bucketElapsedMs(-1)).toBe(0);
    });
  });
});
