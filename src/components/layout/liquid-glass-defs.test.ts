import { describe, expect, it } from "vitest";
import { createConvexRefractionProfile } from "./liquid-glass-defs";

describe("createConvexRefractionProfile", () => {
  it("creates a strong edge displacement that settles to neutral inside", () => {
    const profile = createConvexRefractionProfile();

    expect(profile.normalized).toHaveLength(128);
    expect(profile.normalized[0]).toBeCloseTo(1, 2);
    expect(profile.normalized[127]).toBeCloseTo(0, 3);
    expect(profile.maximumDisplacement).toBeGreaterThan(0);
  });

  it("scales physical displacement with refraction strength", () => {
    const soft = createConvexRefractionProfile(35);
    const strong = createConvexRefractionProfile(70);

    expect(soft.maximumDisplacement).toBeGreaterThan(0);
    expect(strong.maximumDisplacement).toBeGreaterThan(
      soft.maximumDisplacement,
    );
  });
});
