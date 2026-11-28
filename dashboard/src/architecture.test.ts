// Module boundaries of the dashboard, checked on every import (doc/governance ADR 0003).
//
//   api      the contract: client, schemas, generated types. Imports nothing of ours.
//   shared   UI kit and hooks with no business meaning. May import api.
//   features one folder per feature. May import api, shared and other features, without cycles.
//   app      shell, routing, wiring. May import everything; nothing imports it.
//
// Plus two single owners: the network belongs to api/client.ts, browser storage to
// shared/storage.ts (and the session-only login token in api/client.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname);
const LAYERS = ["api", "shared", "features", "app"] as const;
type Layer = (typeof LAYERS)[number];
const MAY_IMPORT: Record<Layer, Layer[]> = {
  api: ["api"],
  shared: ["api", "shared"],
  features: ["api", "shared", "features"],
  app: ["api", "shared", "features", "app"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// Module of a file: `api`, `shared`, `app`, or `features/<name>`; `root` for main.tsx etc.
function moduleOf(path: string) {
  const [first = "", second = ""] = relative(SRC, path).split("/");
  if (first === "features") return { layer: "features" as Layer, name: `features/${second}` };
  if ((LAYERS as readonly string[]).includes(first)) return { layer: first as Layer, name: first };
  return null;
}

const IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms;

function imports(path: string) {
  const out: string[] = [];
  for (const [, spec = ""] of readFileSync(path, "utf8").matchAll(IMPORT)) {
    if (spec.startsWith("@/")) out.push(join(SRC, spec.slice(2)));
    else if (spec.startsWith(".")) out.push(resolve(dirname(path), spec));
  }
  return out;
}

const edges = files(SRC)
  .filter((file) => !file.endsWith("generated.ts"))
  .flatMap((file) => imports(file).map((target) => ({ file, target })))
  .map(({ file, target }) => ({ file, from: moduleOf(file), to: moduleOf(target) }))
  .filter((e) => e.from && e.to && e.from.name !== e.to.name);

describe("dashboard architecture", () => {
  it("found the imports", () => {
    expect(edges.length).toBeGreaterThan(50);
  });

  it("imports only follow the layer order api → shared → features → app", () => {
    const wrong = edges
      .filter((e) => !MAY_IMPORT[e.from!.layer].includes(e.to!.layer))
      .map((e) => `${relative(SRC, e.file)} imports ${e.to!.name}`);
    expect(wrong).toEqual([]);
  });

  it("features do not import each other in a cycle", () => {
    const graph = new Map<string, Set<string>>();
    for (const e of edges)
      if (e.from!.layer === "features" && e.to!.layer === "features")
        graph.set(e.from!.name, (graph.get(e.from!.name) ?? new Set()).add(e.to!.name));
    const cycles: string[] = [];
    const visit = (node: string, path: string[]) => {
      if (path.includes(node)) {
        cycles.push([...path.slice(path.indexOf(node)), node].join(" → "));
        return;
      }
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  const sources = files(SRC).filter((f) => !/\.test\.tsx?$/.test(f) && f !== __filename);
  const usesOutside = (pattern: RegExp, owners: string[]) =>
    sources
      .filter((f) => !owners.includes(relative(SRC, f)) && pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));

  it("only api/client.ts talks to the network", () => {
    expect(usesOutside(/\bfetch\(|new EventSource\b|new WebSocket\b/, ["api/client.ts"])).toEqual(
      [],
    );
  });

  it("only shared/storage.ts (and the token in api/client.ts) uses browser storage", () => {
    expect(
      usesOutside(/\b(localStorage|sessionStorage|indexedDB)\b/, [
        "shared/storage.ts",
        "api/client.ts",
      ]),
    ).toEqual([]);
  });
});
