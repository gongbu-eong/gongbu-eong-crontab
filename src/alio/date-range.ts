export interface DateRange {
  startDate: string;
  endDate: string;
}

function dateParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
  };
}

function formatUtcDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function recentHistoryRange(
  now: Date,
  days: number,
  timezone: string,
): DateRange {
  const today = dateParts(now, timezone);
  const end = new Date(
    Date.UTC(today.year, today.month - 1, today.day),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return {
    startDate: formatUtcDate(start),
    endDate: formatUtcDate(end),
  };
}

export function historyMonthRanges(
  now: Date,
  timezone: string,
  months: number,
): DateRange[] {
  const today = dateParts(now, timezone);
  const finalDate = new Date(
    Date.UTC(today.year, today.month - 1, today.day),
  );
  const startMonthFirstDay = new Date(
    Date.UTC(today.year, today.month - 1 - months, 1),
  );
  const startMonthLastDay = new Date(
    Date.UTC(today.year, today.month - months, 0),
  ).getUTCDate();
  const startDate = new Date(startMonthFirstDay);
  startDate.setUTCDate(Math.min(today.day, startMonthLastDay));

  const cursor = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1),
  );
  const ranges: DateRange[] = [];

  while (cursor <= finalDate) {
    const monthEnd = new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        0,
      ),
    );
    const rangeStart =
      ranges.length === 0 ? startDate : cursor;
    const rangeEnd = monthEnd < finalDate ? monthEnd : finalDate;

    ranges.push({
      startDate: formatUtcDate(rangeStart),
      endDate: formatUtcDate(rangeEnd),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return ranges;
}
