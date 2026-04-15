import { assertEquals, assertThrows } from "@std/assert";

import { bumpReleaseVersion, bumpVersion, formatReleaseTag, parseVersion } from "./release.ts";

Deno.test("parseVersion accepts stable and release candidate versions", () => {
  assertEquals(parseVersion("0.1.2"), {
    major: 0,
    minor: 1,
    patch: 2,
    rc: null,
  });
  assertEquals(parseVersion("1.0.0-rc3"), {
    major: 1,
    minor: 0,
    patch: 0,
    rc: 3,
  });
});

Deno.test("parseVersion rejects unsupported version formats", () => {
  assertThrows(
    () => parseVersion("1.2"),
    Error,
    'Unsupported superctl version "1.2".',
  );
});

Deno.test("bumpVersion handles stable major minor and patch bumps", () => {
  assertEquals(bumpVersion("0.1.2", "patch"), "0.1.3");
  assertEquals(bumpVersion("0.1.2", "minor"), "0.2.0");
  assertEquals(bumpVersion("0.1.2", "major"), "1.0.0");
});

Deno.test("bumpVersion creates and increments release candidate versions", () => {
  assertEquals(bumpVersion("0.1.2", "patch", true), "0.1.3-rc1");
  assertEquals(bumpVersion("0.1.3-rc1", "patch", true), "0.1.3-rc2");
  assertEquals(bumpVersion("0.1.3-rc2", "minor", true), "0.2.0-rc1");
  assertEquals(bumpVersion("1.0.0-rc1", "major", true), "1.0.0-rc2");
});

Deno.test("bumpVersion promotes matching release candidates to stable versions", () => {
  assertEquals(bumpVersion("0.1.3-rc2", "patch"), "0.1.3");
  assertEquals(bumpVersion("0.2.0-rc2", "minor"), "0.2.0");
  assertEquals(bumpVersion("1.0.0-rc2", "major"), "1.0.0");
});

Deno.test("formatReleaseTag prefixes versions with v", () => {
  assertEquals(formatReleaseTag("0.1.3"), "v0.1.3");
  assertEquals(formatReleaseTag("0.1.3-rc1"), "v0.1.3-rc1");
});

Deno.test("bumpReleaseVersion updates deno.json and returns the matching tag", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-release-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await Deno.writeTextFile(
      new URL("deno.json", root),
      JSON.stringify({ version: "0.1.2", name: "superctl" }, null, 2) + "\n",
    );
    await Deno.writeTextFile(
      new URL("README.md", root),
      'superctl = "0.1.2"\n',
    );
    await Deno.mkdir(new URL("scripts/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("scripts/setup-mise-project.sh", root),
      'superctl_version="0.1.2"\n',
    );

    const result = await bumpReleaseVersion(root, "minor", { prerelease: true });
    const updatedConfig = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", root)),
    ) as { version: string };
    const updatedReadme = await Deno.readTextFile(new URL("README.md", root));
    const updatedSetupScript = await Deno.readTextFile(
      new URL("scripts/setup-mise-project.sh", root),
    );

    assertEquals(result, {
      previousVersion: "0.1.2",
      nextVersion: "0.2.0-rc1",
      tag: "v0.2.0-rc1",
    });
    assertEquals(updatedConfig.version, "0.2.0-rc1");
    assertEquals(updatedReadme, 'superctl = "0.2.0-rc1"\n');
    assertEquals(updatedSetupScript, 'superctl_version="0.2.0-rc1"\n');
  } finally {
    await Deno.remove(rootPath, { recursive: true });
  }
});

Deno.test("bumpReleaseVersion can create a matching git tag through its dependency", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-release-tag-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const tags: Array<{ path: string; tag: string }> = [];

  try {
    await Deno.writeTextFile(
      new URL("deno.json", root),
      JSON.stringify({ version: "0.1.2" }, null, 2) + "\n",
    );
    await Deno.writeTextFile(new URL("README.md", root), 'superctl = "0.1.2"\n');
    await Deno.mkdir(new URL("scripts/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("scripts/setup-mise-project.sh", root),
      'superctl_version="0.1.2"\n',
    );

    const result = await bumpReleaseVersion(
      root,
      "patch",
      { createTag: true },
      {
        createGitTag: async (resolvedRoot, tag) => {
          tags.push({ path: resolvedRoot.pathname, tag });
          await Promise.resolve();
        },
      },
    );

    assertEquals(result.tag, "v0.1.3");
    assertEquals(tags, [{ path: root.pathname, tag: "v0.1.3" }]);
  } finally {
    await Deno.remove(rootPath, { recursive: true });
  }
});
