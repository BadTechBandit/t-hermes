import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("BUILT_IN_DRIVERS", () => {
  it("registers Hermes as a multi-instance built-in driver", () => {
    const hermes = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "hermes");

    expect(hermes?.metadata).toMatchObject({
      displayName: "Hermes",
      supportsMultipleInstances: true,
    });
  });
});
