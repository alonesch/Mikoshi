import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathExists,
  previewPathMapping,
  resolveProjectPath,
  toPortableProjectPath,
} from "../src/main/services/path-mapping.ts";

test("mapeia referências internas relativas sem remapear paths externos", () => {
  const mapping = previewPathMapping("F:\\Repos\\Relic", "/home/user/repos/relic");

  assert.equal(
    toPortableProjectPath("F:\\Repos\\Relic\\src\\main.ts", mapping),
    "<PROJECT_ROOT>/src/main.ts",
  );
  assert.equal(toPortableProjectPath("C:\\Users\\user\\secrets.txt", mapping), null);
  assert.equal(toPortableProjectPath("F:\\Repos\\RelicOther\\file", mapping), null);
  assert.equal(
    resolveProjectPath("<PROJECT_ROOT>/src/main.ts", mapping),
    "/home/user/repos/relic/src/main.ts",
  );
  assert.equal(resolveProjectPath("<PROJECT_ROOT>/../../secret", mapping), null);
});

test("valida roots de destino e representa mapping Windows para Linux", async () => {
  const mapping = previewPathMapping("F:\\Repos\\Relic", "/home/user/repos/relic");

  assert.equal(mapping.sourceRoot, "F:\\Repos\\Relic");
  assert.equal(mapping.targetRoot, "/home/user/repos/relic");
  assert.throws(() => previewPathMapping("relative\\project", ""), /absoluto/i);
  const existing = await mkdtemp(join(tmpdir(), "mikoshi-path-"));
  assert.equal(await pathExists(existing), true);
  assert.equal(await pathExists(join(existing, "missing")), false);
});

test("preserva raízes de volume Windows no preview de mapeamento", () => {
  assert.equal(previewPathMapping("C:\\", "D:\\").sourceRoot, "C:\\");
  assert.equal(previewPathMapping("C:\\", "D:\\").targetRoot, "D:\\");
});

test("remapeia uma raiz Windows para outra raiz Windows", () => {
  const mapping = previewPathMapping(
    "F:\\Repos\\Relic",
    "C:\\Users\\user\\source\\repos\\Relic",
  );

  assert.equal(
    toPortableProjectPath("F:\\Repos\\Relic\\src\\Relic.Api\\Program.cs", mapping),
    "<PROJECT_ROOT>/src/Relic.Api/Program.cs",
  );
  assert.equal(
    resolveProjectPath("<PROJECT_ROOT>/src/Relic.Api/Program.cs", mapping),
    "C:\\Users\\user\\source\\repos\\Relic\\src\\Relic.Api\\Program.cs",
  );
});
