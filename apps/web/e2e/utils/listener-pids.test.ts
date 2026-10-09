// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listenerPids,
  type ListenerTool,
  type RunTool,
  type ToolRun,
} from "./listener-pids";

/**
 * The global setup refuses to run E2E against a port it cannot attribute to the hermetic stack, so
 * the lookup must find the real owner wherever the suite runs and must never turn unreadable tool
 * output into a shorter list.
 */

const LSOF_ARGS = ["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"];
const FUSER_ARGS = ["-n", "tcp", "3000"];

function fakeTools(answers: Partial<Record<ListenerTool, ToolRun>>): {
  run: RunTool;
  calls: [ListenerTool, readonly string[]][];
} {
  const calls: [ListenerTool, readonly string[]][] = [];
  return {
    calls,
    run: (tool, args) => {
      calls.push([tool, args]);
      return answers[tool];
    },
  };
}

const found = (stdout: string): ToolRun => ({ status: 0, stdout });
const nothing: ToolRun = { status: 1, stdout: "" };

describe("listenerPids", () => {
  it("keeps lsof's answer and does not ask fuser when lsof names the listener", () => {
    const tools = fakeTools({ lsof: found("4242\n"), fuser: found(" 9999") });

    expect(listenerPids("3000", tools.run)).toEqual({
      tool: "lsof",
      pids: [4242],
    });
    expect(tools.calls).toEqual([["lsof", LSOF_ARGS]]);
  });

  it("asks fuser when lsof finds no listener, as lsof 4.95 does for next-server on Linux", () => {
    const tools = fakeTools({ lsof: nothing, fuser: found("   4242") });

    expect(listenerPids("3000", tools.run)).toEqual({
      tool: "fuser",
      pids: [4242],
    });
    expect(tools.calls).toEqual([
      ["lsof", LSOF_ARGS],
      ["fuser", FUSER_ARGS],
    ]);
  });

  it("asks fuser when lsof is not installed", () => {
    const tools = fakeTools({ lsof: undefined, fuser: found(" 4242") });

    expect(listenerPids("3000", tools.run)).toEqual({
      tool: "fuser",
      pids: [4242],
    });
  });

  it("asks fuser when lsof exits 0 without printing a pid", () => {
    const tools = fakeTools({ lsof: found("\n"), fuser: found(" 4242") });

    expect(listenerPids("3000", tools.run).tool).toBe("fuser");
  });

  it("does not trust pids lsof printed before failing", () => {
    const tools = fakeTools({
      lsof: { status: 1, stdout: "4242\n" },
      fuser: found(" 4242 5151"),
    });

    expect(listenerPids("3000", tools.run)).toEqual({
      tool: "fuser",
      pids: [4242, 5151],
    });
  });

  it("names no listener when neither tool can", () => {
    expect(listenerPids("3000", fakeTools({}).run)).toEqual({
      tool: undefined,
      pids: [],
    });
    expect(
      listenerPids("3000", fakeTools({ lsof: nothing, fuser: nothing }).run),
    ).toEqual({ tool: undefined, pids: [] });
    expect(
      listenerPids(
        "3000",
        fakeTools({ lsof: nothing, fuser: { status: 1, stdout: " 4242" } }).run,
      ),
    ).toEqual({ tool: undefined, pids: [] });
  });

  it("returns distinct pids in ascending order", () => {
    expect(
      listenerPids("3000", fakeTools({ lsof: found("812\n77\n812\n") }).run)
        .pids,
    ).toEqual([77, 812]);
    expect(
      listenerPids(
        "3000",
        fakeTools({ lsof: nothing, fuser: found("  812  77\t812\n") }).run,
      ).pids,
    ).toEqual([77, 812]);
  });

  it.each([
    ["a word", "4242\nnext-server\n"],
    ["pid 0", "0\n"],
    ["a negative pid", "-4242\n"],
    ["a leading zero", "04242\n"],
    ["a fuser access suffix", "4242e\n"],
    ["a pid beyond pid_t", "2147483648\n"],
    ["a decimal", "42.5\n"],
  ])("refuses lsof output containing %s", (_label, stdout) => {
    expect(() =>
      listenerPids("3000", fakeTools({ lsof: found(stdout) }).run),
    ).toThrow(/lsof printed .* where only process ids were expected/);
  });

  it("refuses fuser output that is not a list of pids", () => {
    expect(() =>
      listenerPids(
        "3000",
        fakeTools({ lsof: nothing, fuser: found(" 4242c 5151") }).run,
      ),
    ).toThrow(/fuser printed "4242c" where only process ids were expected/);
  });

  // The real tools, against a real listener titled the way Next.js titles its server: lsof answers
  // on macOS, fuser on a Linux host whose lsof drops the process. Skipped where fuser is missing,
  // since a host with only an affected lsof cannot attribute the listener at all.
  it.skipIf(!onPath("fuser"))(
    "finds a real listener titled next-server (vX.Y.Z)",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.title = 'next-server (v16.1.6)';" +
            "const server = require('node:net').createServer();" +
            "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      try {
        const port = await new Promise<string>((resolve, reject) => {
          child.stdout.once("data", (chunk: Buffer) =>
            resolve(chunk.toString().trim()),
          );
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error(`listener exited early (${code})`)),
          );
        });

        expect(listenerPids(port).pids).toEqual([child.pid]);
      } finally {
        child.kill();
      }
    },
  );
});

function onPath(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some(
      (directory) => directory !== "" && existsSync(join(directory, command)),
    );
}
