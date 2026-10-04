import { lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { PathMapping } from "../../contracts.ts";

function flavor(value: string): "windows" | "posix" {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) ? "windows" : "posix";
}

function normalizeRoot(value: string): string {
  const path = flavor(value) === "windows" ? win32 : posix;
  const normalized = path.resolve(value);
  const root = path.parse(normalized).root;
  if (normalized.toLocaleLowerCase("en-US") === root.toLocaleLowerCase("en-US"))
    return root;
  return normalized.replace(/[\\/]+$/, "") || root;
}

export function previewPathMapping(sourceRoot: string, targetRoot: string): PathMapping {
  if (
    typeof sourceRoot !== "string" ||
    typeof targetRoot !== "string" ||
    !sourceRoot.trim() ||
    !targetRoot.trim() ||
    !isAbsolute(sourceRoot) ||
    !isAbsolute(targetRoot)
  ) {
    throw new Error("As duas raízes do mapeamento devem ser caminhos absolutos.");
  }

  return {
    sourceRoot: normalizeRoot(sourceRoot),
    targetRoot: normalizeRoot(targetRoot),
    targetExists: false,
  };
}

function isAbsolute(value: string): boolean {
  return flavor(value) === "windows" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

function relativeToRoot(value: string, root: string): string | null {
  const path = flavor(root) === "windows" ? win32 : posix;
  const relative = path.relative(root, path.resolve(value));
  if (
    relative === ".." ||
    relative.startsWith("..\\") ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

export function toPortableProjectPath(
  value: string,
  mapping: PathMapping,
): string | null {
  if (value.startsWith("<PROJECT_ROOT>")) {
    return resolveProjectPath(value, mapping) ? value.replace(/\\/g, "/") : null;
  }

  if (flavor(value) !== flavor(mapping.sourceRoot)) return null;
  const relative = relativeToRoot(value, mapping.sourceRoot);
  if (relative === null) return null;
  return ["<PROJECT_ROOT>", ...relative.split(/[\\/]/).filter(Boolean)].join("/");
}

export function resolveProjectPath(value: string, mapping: PathMapping): string | null {
  const match = value.match(/^<PROJECT_ROOT>(?:[\\/](.*))?$/);
  if (!match) return null;

  const suffix = (match[1] ?? "").replace(
    /[\\/]+/g,
    flavor(mapping.targetRoot) === "windows" ? "\\" : "/",
  );
  const path = flavor(mapping.targetRoot) === "windows" ? win32 : posix;
  const resolved = path.resolve(mapping.targetRoot, suffix);
  return relativeToRoot(resolved, mapping.targetRoot) === null ? null : resolved;
}

export async function pathExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export function remapTextPaths(text: string, mappings: PathMapping[]): string {
  return mappings.reduce((current, mapping) => {
    const escaped = mapping.sourceRoot
      .replace(/[\\/]$/, "")
      .split(/[\\/]/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]");
    return current.replace(
      new RegExp(
        escaped + "(?=[\\\\/]|[\\s\"'<>)]|$)",
        flavor(mapping.sourceRoot) === "windows" ? "gi" : "g",
      ),
      "<PROJECT_ROOT>",
    );
  }, text);
}

export function countMappedPathReferences(text: string, mapping: PathMapping): number {
  const escaped = mapping.sourceRoot
    .replace(/[\\/]$/, "")
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  const matches = text.match(
    new RegExp(
      escaped + "(?=[\\\\/]|[\\s\"'<>)]|$)",
      flavor(mapping.sourceRoot) === "windows" ? "gi" : "g",
    ),
  );
  return matches?.length ?? 0;
}
