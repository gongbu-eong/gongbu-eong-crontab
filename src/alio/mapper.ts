import { createHash } from "node:crypto";

import type {
  AlioFile,
  AlioPosting,
  AlioStep,
  JsonObject,
  NormalizedAlioPosting,
} from "./types";

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function integerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const normalized = stringValue(value)?.replaceAll(",", "");
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function koreaDateToIso(
  value: unknown,
  endOfDay = false,
): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }

  const digits = raw.replaceAll(/[^0-9]/g, "");
  if (digits.length !== 8) {
    return null;
  }

  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const result = `${year}-${month}-${day}T${time}+09:00`;

  return Number.isNaN(Date.parse(result)) ? null : result;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }

  return value;
}

export function postingContentHash(item: AlioPosting): string {
  // D-day와 목록 API의 빈 상세 배열은 매일 바뀌거나 상세 내용이 아니므로
  // 비교 대상에서 제외한다.
  const ignoredKeys = new Set(["decimalDay", "files", "steps"]);
  const content = Object.fromEntries(
    Object.entries(item).filter(([key]) => !ignoredKeys.has(key)),
  );

  return createHash("sha256")
    .update(JSON.stringify(stableValue(content)))
    .digest("hex");
}

function unwrapArray<T extends JsonObject>(
  value: unknown,
  wrapperName: string,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const object = entry as JsonObject;
    const wrapped = object[wrapperName];

    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      return [wrapped as T];
    }

    return [object as T];
  });
}

export function normalizePosting(
  listItem: AlioPosting,
  detail: AlioPosting | null,
): NormalizedAlioPosting {
  const sourcePostingId = stringValue(listItem.recrutPblntSn);
  const title = stringValue(listItem.recrutPbancTtl);
  const institutionName = stringValue(listItem.instNm);

  if (!sourcePostingId || !title || !institutionName) {
    throw new Error(
      "알리오 응답에 recrutPblntSn, recrutPbancTtl 또는 instNm이 없습니다.",
    );
  }

  const merged = detail ? { ...listItem, ...detail } : listItem;
  const institutionCode =
    stringValue(merged.pblntInstCd) ??
    stringValue(merged.pbadmsStdInstCd) ??
    `unknown-${sourcePostingId}`;
  const preferences = [stringValue(merged.prefCn), stringValue(merged.prefCondCn)]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  return {
    sourcePostingId,
    institutionCode,
    institutionName,
    title,
    ncsCategory: stringValue(merged.ncsCdNmLst),
    jobCategory: stringValue(merged.ncsCdLst),
    workRegion: stringValue(merged.workRgnNmLst),
    employmentType: stringValue(merged.hireTypeNmLst),
    hiringCount: integerValue(merged.recrutNope),
    educationRequirement: stringValue(merged.acbgCondNmLst),
    careerRequirement: stringValue(merged.recrutSeNm),
    applicationStartAt: koreaDateToIso(merged.pbancBgngYmd),
    applicationEndAt: koreaDateToIso(merged.pbancEndYmd, true),
    announcementAt: koreaDateToIso(merged.pbancBgngYmd),
    applyUrl: stringValue(merged.srcUrl),
    qualification: stringValue(merged.aplyQlfcCn),
    disqualification: stringValue(merged.disqlfcRsn),
    preference: preferences || null,
    screeningProcess: stringValue(merged.scrnprcdrMthdExpln),
    applicationMethod: stringValue(merged.srcUrl),
    additionalNotice: stringValue(merged.nonatchRsn),
    contentHash: postingContentHash(listItem),
    rawPayload: {
      list: listItem,
      detail,
    },
    // 진행 여부는 상세 응답이 아니라 목록 스냅샷을 기준으로 판단한다.
    isActive:
      stringValue(listItem.ongoingYn)?.toUpperCase() === "Y",
    detailFetched: detail !== null,
    files: unwrapArray<AlioFile>(detail?.files, "file"),
    steps: unwrapArray<AlioStep>(detail?.steps, "step"),
  };
}
