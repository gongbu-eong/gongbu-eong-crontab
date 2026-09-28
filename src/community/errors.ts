const databaseReasons: Record<string, string> = {
  "22001": "text exceeds column length",
  "23502": "required column is null",
  "23503": "foreign key violation",
  "23505": "unique constraint violation",
  "23514": "check constraint violation",
  "42501": "insufficient database privileges or RLS denied access",
  "42703": "undefined column; check database migrations",
  "42P01": "undefined table; check database migrations",
  "55P03": "database lock unavailable or lock timeout",
  "57014": "query cancelled or statement timeout",
};

export function diagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.\[\]-]{1,160}$/.test(value) && !value.startsWith("sk-")
    ? value : undefined;
}

export function summarizeSeedError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown failure (non-Error thrown)";
  const metadata = error as Error & { code?: unknown; table?: unknown; column?: unknown; constraint?: unknown };
  const code = diagnosticCode(metadata.code);
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    // PostgreSQL messages/details can contain complete rows, including user content.
    const context = ["table", "column", "constraint"] as const;
    const fields = context.flatMap((key) => {
      const value = diagnosticCode(metadata[key]);
      return value ? [`${key}=${value}`] : [];
    });
    return [`PostgreSQL ${code}`, databaseReasons[code], ...fields].filter(Boolean).join("; ");
  }
  return error.message
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, "[redacted URL]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[redacted key]")
    .replace(/\b(?:GPT_API_KEY|OPENAI_API_KEY|CRON_MANUAL_RUN_TOKEN)\s*[=:]\s*[^\s,;]+/gi, "[redacted credential]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 1200) || "Unknown error";
}
