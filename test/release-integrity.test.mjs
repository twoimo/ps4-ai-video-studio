import { describe, expect, test } from "bun:test";

import { inspectReleaseIntegrity, mutableWorkflowActions } from "../scripts/check-release-integrity.mjs";

describe("release integrity", () => {
  test("release files are tracked and relative imports resolve", async () => {
    expect(await inspectReleaseIntegrity()).toEqual({
      missingImports: [],
      mutableActions: [],
      untracked: [],
      gitExitCode: 0
    });
  });

  test("parses every YAML action shape and rejects mutable or malformed references", () => {
    const immutableSha = "0123456789abcdef0123456789abcdef01234567";
    const workflow = [
      "steps:",
      "  - uses: actions/checkout@v4",
      "  - { uses: owner/inline@v1 }",
      "  - { \"uses\": owner/quoted@main }",
      "  - uses : owner/spaced@latest",
      "  - uses: ./local-action",
      `  - uses: \"owner/action@${immutableSha}\"`,
      "  - uses: 123",
      "  - uses: docker://registry.example/image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    ].join("\n");
    expect(mutableWorkflowActions(workflow, ".github/workflows/test.yml")).toEqual([
      { workflow: ".github/workflows/test.yml", reference: "actions/checkout@v4" },
      { workflow: ".github/workflows/test.yml", reference: "owner/inline@v1" },
      { workflow: ".github/workflows/test.yml", reference: "owner/quoted@main" },
      { workflow: ".github/workflows/test.yml", reference: "owner/spaced@latest" },
      { workflow: ".github/workflows/test.yml", reference: "<non-string:number>" }
    ]);
    expect(mutableWorkflowActions("steps: [", ".github/workflows/broken.yml")).toEqual([
      { workflow: ".github/workflows/broken.yml", reference: "<invalid-yaml>" }
    ]);
  });
});
