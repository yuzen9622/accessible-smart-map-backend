#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const allowlist = new Set([
  // Keep intentional legacy exceptions explicit and removable.
]);

function toRel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function roleFor(file) {
  if (file.endsWith(".router.ts")) return "router";
  if (file.endsWith(".controller.ts")) return "controller";
  if (file.endsWith(".service.ts")) return "service";
  if (file.endsWith(".repository.ts")) return "repository";
  if (file.endsWith(".orchestration.ts")) return "orchestration";
  if (file.endsWith(".schema.ts")) return "schema";
  return undefined;
}

function moduleFor(file) {
  const rel = toRel(file);
  const match = /^src\/modules\/([^/]+)\//.exec(rel);
  return match?.[1];
}

function importSpecs(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

/**
 * Dynamic `import("...")` specifiers. Tracked separately because they carry a
 * real runtime dependency for cycle purposes but are deliberately used inside a
 * module to defer loading, so they are not subject to the role rules.
 */
function dynamicImportSpecs(source) {
  const specs = [];
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.push(match[1]);
  }
  return specs;
}

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  const normalizedBase = base.endsWith(".js") ? base.slice(0, -3) : base;
  const candidates = [
    normalizedBase,
    `${normalizedBase}.ts`,
    `${normalizedBase}.tsx`,
    path.join(normalizedBase, "index.ts"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function addViolation(violations, fromFile, spec, reason) {
  const key = `${toRel(fromFile)}::${spec}::${reason}`;
  if (allowlist.has(key)) return;
  violations.push(`${toRel(fromFile)} imports "${spec}" — ${reason}`);
}

const violations = [];
const moduleEdges = new Map();

function recordModuleEdge(fromFile, target, spec) {
  const from = moduleFor(fromFile);
  const to = target && moduleFor(target);
  if (!from || !to || from === to) return;
  if (!moduleEdges.has(from)) moduleEdges.set(from, new Map());
  if (!moduleEdges.get(from).has(to)) {
    moduleEdges.get(from).set(to, `${toRel(fromFile)} imports "${spec}"`);
  }
}

for (const file of walk(srcDir)) {
  if (file.endsWith(".test.ts")) continue;
  const role = roleFor(file);
  const source = fs.readFileSync(file, "utf8");

  // Deferred `import()` still couples the two modules at runtime, so it counts
  // for cycle detection even though it is exempt from the role rules below.
  for (const spec of dynamicImportSpecs(source)) {
    recordModuleEdge(file, resolveRelative(file, spec), spec);
  }

  for (const spec of importSpecs(source)) {
    const target = resolveRelative(file, spec);
    const targetRel = target ? toRel(target) : spec;
    const targetRole = target ? roleFor(target) : undefined;

    recordModuleEdge(file, target, spec);

    if (role === "router" && targetRole === "service") {
      addViolation(violations, file, spec, "routers must delegate through controllers, not services");
    }

    if (role === "controller") {
      if (targetRole === "router") {
        addViolation(violations, file, spec, "controllers must not import routers");
      }
      if (targetRole === "controller" && moduleFor(file) !== moduleFor(target)) {
        addViolation(violations, file, spec, "controllers must not import controllers from another module");
      }
      if (targetRel.startsWith("src/model/")) {
        addViolation(violations, file, spec, "controllers must not import models directly");
      }
    }

    if (role === "service") {
      if (spec === "express") {
        addViolation(violations, file, spec, "services must not import Express transport types");
      }
      if (targetRole === "controller" || targetRole === "router") {
        addViolation(violations, file, spec, "services must not import transport layers");
      }
      if (targetRel.startsWith("src/model/")) {
        addViolation(
          violations,
          file,
          spec,
          "services must not import models directly — go through the module's repository",
        );
      }
    }

    // Orchestration composes several modules' services on purpose, so it is
    // exempt from the service-to-service restriction — but it is still domain
    // code and must not reach the transport or persistence layers directly.
    if (role === "orchestration") {
      if (spec === "express") {
        addViolation(violations, file, spec, "orchestration must not import Express transport types");
      }
      if (targetRole === "controller" || targetRole === "router") {
        addViolation(violations, file, spec, "orchestration must not import transport layers");
      }
      if (targetRel.startsWith("src/model/")) {
        addViolation(
          violations,
          file,
          spec,
          "orchestration must not import models directly — go through a repository",
        );
      }
    }

    if (role === "repository") {
      if (spec === "express") {
        addViolation(violations, file, spec, "repositories must not import Express transport types");
      }
      if (
        targetRole === "controller" ||
        targetRole === "router" ||
        targetRole === "service"
      ) {
        addViolation(
          violations,
          file,
          spec,
          "repositories must not depend upward on controllers, routers or services",
        );
      }
    }

    if (role === "schema") {
      if (targetRel.startsWith("src/model/") || targetRel.startsWith("src/adapters/")) {
        addViolation(violations, file, spec, "schemas must stay I/O-free");
      }
    }
  }
}

/**
 * Reports every dependency cycle between modules under src/modules.
 *
 * Modules are the unit rather than files: a cycle between two modules is an
 * architecture problem even when no single file imports itself back.
 */
function findModuleCycles(edges) {
  const cycles = [];
  const seen = new Set();
  const state = new Map();
  const stack = [];

  function visit(node) {
    state.set(node, "open");
    stack.push(node);
    for (const next of edges.get(node)?.keys() ?? []) {
      const nextState = state.get(node === next ? node : next);
      if (nextState === "open") {
        const path = [...stack.slice(stack.indexOf(next)), next];
        const key = path.join(" -> ");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(
            `${key}\n    ${path
              .slice(0, -1)
              .map((from, i) => `${from} -> ${path[i + 1]}: ${edges.get(from).get(path[i + 1])}`)
              .join("\n    ")}`,
          );
        }
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  }

  for (const node of edges.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

for (const cycle of findModuleCycles(moduleEdges)) {
  violations.push(`module dependency cycle: ${cycle}`);
}

if (violations.length) {
  console.error("Architecture boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Architecture boundary check passed.");
