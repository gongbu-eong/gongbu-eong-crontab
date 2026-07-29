type LogLevel = "info" | "warn" | "error";

function write(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): void {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  });

  if (level === "error") {
    console.error(payload);
    return;
  }

  if (level === "warn") {
    console.warn(payload);
    return;
  }

  console.log(payload);
}

export const logger = {
  info(message: string, context?: Record<string, unknown>) {
    write("info", message, context);
  },
  warn(message: string, context?: Record<string, unknown>) {
    write("warn", message, context);
  },
  error(message: string, context?: Record<string, unknown>) {
    write("error", message, context);
  },
};

