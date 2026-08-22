#!/usr/bin/env bun

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const RELEASE_DIRECTORIES = Object.freeze([
  ".github/workflows",
  "data",
  "docs",
  "public",
  "scripts",
  "src",
  "test",
  "tests"
]);
const RELEASE_ROOT_FILES = Object.freeze([
  ".env.example",
  ".gitignore",
  "NOTICE.md",
  "README.md",
  "bunfig.toml",
  "package.json"
]);
const JAVASCRIPT = /\.(?:mjs|js)$/u;

async function regularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(path));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
  }
  return files;
}

function relativeModuleSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/gu,
    /\bimport\s+["'](\.{1,2}\/[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu
  ];
  return [...new Set(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])))];
}

function localPackageScriptPaths(packageJson) {
  const paths = [];
  const pattern = /(?:^|[\s"'=])((?:\.\/)?(?:data|public|scripts|src|test|tests)\/[A-Za-z0-9_./-]+\.(?:json|mjs|js|toml))/gu;
  for (const command of Object.values(packageJson.scripts || {})) {
    for (const match of String(command).matchAll(pattern)) paths.push(match[1].replace(/^\.\//u, ""));
  }
  return [...new Set(paths)];
}

function bunfigPreloadPaths(source) {
  const preload = source.match(/^\s*preload\s*=\s*\[([^\]]*)\]/mu)?.[1] || "";
  return [...preload.matchAll(/["'](\.[^"']+)["']/gu)].map((match) => match[1]);
}

export function mutableWorkflowActions(source, workflow) {
  let document;
  try {
    document = Bun.YAML.parse(source);
  } catch {
    return [{ workflow, reference: "<invalid-yaml>" }];
  }
  const findings = [];
  const visited = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Object.prototype.hasOwnProperty.call(value, "uses")) {
      const reference = value.uses;
      const localAction = typeof reference === "string" && reference.startsWith("./");
      const immutableRepositoryAction = typeof reference === "string"
        && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[a-f0-9]{40}$/u.test(reference);
      const immutableContainerAction = typeof reference === "string"
        && /^docker:\/\/[^\s@]+@sha256:[a-f0-9]{64}$/u.test(reference);
      if (!localAction && !immutableRepositoryAction && !immutableContainerAction) {
        findings.push({
          workflow,
          reference: typeof reference === "string" ? reference : `<non-string:${typeof reference}>`
        });
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(document);
  return findings;
}

function insideRoot(root, path) {
  const local = relative(root, path);
  return local && local !== ".." && !local.startsWith(`..${sep}`);
}

export async function inspectReleaseIntegrity(root = resolve(import.meta.dirname, "..")) {
  const candidates = new Set(RELEASE_ROOT_FILES);
  for (const directory of RELEASE_DIRECTORIES) {
    for (const path of await regularFiles(resolve(root, directory))) candidates.add(relative(root, path));
  }

  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const path of localPackageScriptPaths(packageJson)) candidates.add(path);
  const bunfig = await readFile(resolve(root, "bunfig.toml"), "utf8");
  for (const specifier of bunfigPreloadPaths(bunfig)) candidates.add(relative(root, resolve(root, specifier)));

  const missingImports = [];
  const mutableActions = [];
  for (const importer of [...candidates].filter((path) => JAVASCRIPT.test(path))) {
    const importerPath = resolve(root, importer);
    const source = await readFile(importerPath, "utf8");
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = resolve(dirname(importerPath), specifier);
      const targetStat = insideRoot(root, target) ? await stat(target).catch(() => null) : null;
      if (!targetStat?.isFile()) {
        missingImports.push({ importer, specifier });
      } else {
        candidates.add(relative(root, target));
      }
    }
  }
  for (const workflow of [...candidates].filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path))) {
    const source = await readFile(resolve(root, workflow), "utf8");
    mutableActions.push(...mutableWorkflowActions(source, workflow));
  }

  const paths = [...candidates].sort();
  const git = Bun.spawnSync({
    cmd: ["git", "ls-files", "--error-unmatch", "--", ...paths],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  });
  const tracked = new Set(git.stdout.toString().trim().split("\n").filter(Boolean));
  return {
    missingImports,
    mutableActions,
    untracked: paths.filter((path) => !tracked.has(path)),
    gitExitCode: git.exitCode
  };
}

if (import.meta.main) {
  const result = await inspectReleaseIntegrity();
  if (result.missingImports.length || result.mutableActions.length || result.untracked.length || result.gitExitCode !== 0) {
    if (result.missingImports.length) {
      process.stderr.write(`Missing relative imports:\n${result.missingImports.map((entry) => `- ${entry.importer} -> ${entry.specifier}`).join("\n")}\n`);
    }
    if (result.mutableActions.length) {
      process.stderr.write(`Mutable external workflow actions:\n${result.mutableActions.map((entry) => `- ${entry.workflow} -> ${entry.reference}`).join("\n")}\n`);
    }
    if (result.untracked.length) {
      process.stderr.write(`Release-critical files are not tracked:\n${result.untracked.map((path) => `- ${path}`).join("\n")}\n`);
    }
    process.exitCode = 1;
  }
}
