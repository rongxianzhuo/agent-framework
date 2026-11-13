import { describe, expect, it } from "vitest";

import * as pkg from "../src/index.js";

describe("package entry point", () => {
  it("is importable and exports the version", () => {
    expect(pkg.VERSION).toBe("0.1.0");
  });
});
