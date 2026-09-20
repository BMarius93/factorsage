import { describe, expect, it } from "vitest";
import { parseLauncherArguments, UsageError } from "./launcher-options";

/**
 * The command line is the only input the manual launcher takes, and a mistyped one would open four
 * browsers pointed somewhere useless. Parsing is therefore checked on its own, without a browser.
 */
describe("parseLauncherArguments", () => {
  it("opens every manual persona on the dashboard by default", () => {
    const options = parseLauncherArguments([], {});

    expect(options.personas.map((persona) => persona.slug)).toEqual([
      "free",
      "starter",
      "pro",
      "admin",
    ]);
    expect(options.route).toBe("/dashboard");
    expect(options.baseUrl).toBe("http://localhost:3000");
  });

  it("accepts a shared route in either flag spelling", () => {
    expect(parseLauncherArguments(["--route=/lists"], {}).route).toBe("/lists");
    expect(
      parseLauncherArguments(["--route", "/backtests/new"], {}).route,
    ).toBe("/backtests/new");
  });

  it("ignores the `--` separator pnpm forwards", () => {
    const options = parseLauncherArguments(["--", "--route=/monitors"], {});

    expect(options.route).toBe("/monitors");
    expect(options.personas).toHaveLength(4);
    expect(
      parseLauncherArguments(["free", "--", "--route=/monitors"], {}).route,
    ).toBe("/monitors");
  });

  it("selects a single persona by its handle", () => {
    const options = parseLauncherArguments(["free"], {});

    expect(options.personas.map((persona) => persona.name)).toEqual([
      "FREE_USER",
    ]);
  });

  it("refuses a route that is not a path on the app", () => {
    expect(() =>
      parseLauncherArguments(["--route=https://example.com/lists"], {}),
    ).toThrow(UsageError);
  });

  it("refuses an unknown persona and an unknown option", () => {
    expect(() => parseLauncherArguments(["downgraded"], {})).toThrow(
      /Unknown persona/,
    );
    expect(() => parseLauncherArguments(["--headless"], {})).toThrow(
      /Unknown option/,
    );
  });

  it("takes the base URL from a flag, then the environment, and trims a trailing slash", () => {
    expect(
      parseLauncherArguments(["--base-url=http://127.0.0.1:4000/"], {}).baseUrl,
    ).toBe("http://127.0.0.1:4000");
    expect(
      parseLauncherArguments([], { QA_BASE_URL: "http://localhost:4100" })
        .baseUrl,
    ).toBe("http://localhost:4100");
  });
});
