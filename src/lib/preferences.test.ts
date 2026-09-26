import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  recordRecent,
  savePreferences,
  toggleId,
} from "./preferences";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("local preferences", () => {
  it("survives malformed persisted data", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREFERENCES_KEY, "{broken");
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips favorites and selection", () => {
    const storage = new MemoryStorage();
    const preferences = {
      ...DEFAULT_PREFERENCES,
      favoriteThemeIds: ["midnight-harbor"],
      favoritePairIds: ["harbor-horizon"],
      selectedThemeId: "midnight-harbor",
    };
    savePreferences(preferences, storage);
    expect(loadPreferences(storage)).toEqual(preferences);
  });

  it("toggles favorites without duplicates", () => {
    expect(toggleId([], "one")).toEqual(["one"]);
    expect(toggleId(["one", "two"], "one")).toEqual(["two"]);
  });

  it("keeps six most recent unique entries", () => {
    const recent = ["a", "b", "c", "d", "e", "f"];
    expect(recordRecent(recent, "c")).toEqual(["c", "a", "b", "d", "e", "f"]);
    expect(recordRecent(recent, "g")).toEqual(["g", "a", "b", "c", "d", "e"]);
  });
});
