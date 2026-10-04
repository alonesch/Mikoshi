export function sanitize(input: string): {
  text: string;
  redactions: number;
  highConfidenceRedactions: number;
  heuristicCandidates: number;
} {
  let redactions = 0;
  let highConfidenceRedactions = 0;
  let heuristicCandidates = 0;
  const redact = () => {
    redactions++;
    highConfidenceRedactions++;
    return "[REDACTED_SECRET]";
  };
  const redactHeuristic = () => {
    redactions++;
    heuristicCandidates++;
    return "[REDACTED_SECRET]";
  };
  let text = input
    .replace(
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g,
      redact,
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:npm|pypi)-[A-Za-z0-9_-]{20,})\b/g,
      redact,
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, redact)
    .replace(
      /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|mariadb|mssql|redis|amqps?):\/\/[^\s"'<>]+/gi,
      redact,
    )
    .replace(
      /((?:["']?)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|connection[_-]?string|client[_-]?secret|accountkey|sharedaccesssignature)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi,
      (_all, prefix: string) => prefix + redact(),
    )
    .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@[^\s]+/gi, redact);
  text = text.replace(/\b[A-Za-z0-9_+/=-]{36,}\b/g, (value) => {
    if (/^[a-f\d-]+$/i.test(value) || value.includes("REDACTED")) return value;
    const frequencies = new Map<string, number>();
    for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce(
      (sum, count) => sum - (count / value.length) * Math.log2(count / value.length),
      0,
    );
    return entropy > 4.3 ? redactHeuristic() : value;
  });
  return { text, redactions, highConfidenceRedactions, heuristicCandidates };
}

export function isSensitiveFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const name = segments.at(-1) ?? "";
  const sensitiveDirectory =
    /^(?:\.git|\.ssh|\.aws|\.azure|\.claude|\.codex|auth|credentials|tokens?)$/;
  const sensitiveName =
    /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx))$/i;
  return (
    segments.some((segment) => sensitiveDirectory.test(segment)) ||
    sensitiveName.test(name)
  );
}

export function portableText(text: string, root: string): string {
  const escaped = root
    .replace(/[\\/]$/, "")
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  return text
    .replace(
      new RegExp(
        escaped + "(?=[\\\\/]|[\\s\"'<>)]|$)",
        process.platform === "win32" ? "gi" : "g",
      ),
      "<PROJECT_ROOT>",
    )
    .replace(
      /<PROJECT_ROOT>([\\/][^\s"'<>]*)/g,
      (_all, suffix: string) => "<PROJECT_ROOT>" + suffix.replace(/\\/g, "/"),
    );
}

export function cleanText(
  text: string,
  root: string,
): {
  text: string;
  redactions: number;
  highConfidenceRedactions: number;
  heuristicCandidates: number;
} {
  const result = sanitize(portableText(text, root));
  // External machine-specific paths are not portable project references.
  result.text = result.text.replace(
    /\b[A-Z]:[\\/](?:[^\s"'<>]+)|\/(?:home|Users)\/(?:[^\s"'<>]+)/gi,
    "<EXTERNAL_PATH>",
  );
  return result;
}

export function validId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    throw new Error("Identificador inválido.");
}

export function boundedText(value: unknown, limit = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error("Texto vazio ou acima do limite permitido.");
  return value.trim();
}
