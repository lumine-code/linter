/* global describe, it, expect, advanceClock */

const { unique, debounce } = require("../lib/util");

// The linter dropped its lodash dependency in favour of these two helpers.
// The Lumine spec harness installs a fake clock (window.advanceClock drives
// setTimeout), so the debounce edges are exercised deterministically.
describe("lib/util", () => {
  describe("unique", () => {
    it("removes duplicates while preserving first-seen order", () => {
      expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
      expect(unique([])).toEqual([]);
    });
  });

  describe("debounce", () => {
    it("invokes once on the trailing edge by default", () => {
      let calls = 0;
      const fn = debounce(() => calls++, 100);
      fn();
      fn();
      fn();
      expect(calls).toBe(0);
      advanceClock(99);
      expect(calls).toBe(0);
      advanceClock(1);
      expect(calls).toBe(1);
    });

    it("invokes on the leading edge, and again on trailing when re-called in the window", () => {
      let calls = 0;
      const fn = debounce(() => calls++, 100, { leading: true });
      fn();
      expect(calls).toBe(1); // leading edge fires synchronously
      fn(); // second call inside the window schedules a trailing invocation
      advanceClock(100);
      expect(calls).toBe(2);
    });

    it("does not fire the trailing edge for a lone leading call", () => {
      let calls = 0;
      const fn = debounce(() => calls++, 100, { leading: true });
      fn();
      expect(calls).toBe(1);
      advanceClock(100);
      expect(calls).toBe(1);
    });

    it("invokes with the latest arguments and receiver", () => {
      const seen = [];
      const fn = debounce(function (x) {
        seen.push([this.tag, x]);
      }, 100);
      fn.call({ tag: "a" }, 1);
      fn.call({ tag: "b" }, 2);
      advanceClock(100);
      expect(seen).toEqual([["b", 2]]);
    });

    it("cancel() clears a pending trailing invocation", () => {
      let calls = 0;
      const fn = debounce(() => calls++, 100);
      fn();
      fn.cancel();
      advanceClock(100);
      expect(calls).toBe(0);
    });
  });
});
