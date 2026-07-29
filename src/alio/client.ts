import { setTimeout as delay } from "node:timers/promises";

import { env } from "../config";
import { logger } from "../logger";
import type {
  AlioApiResponse,
  AlioListFilters,
  AlioListResult,
  AlioPosting,
  JsonObject,
} from "./types";

function isSuccessCode(code: unknown): boolean {
  return (
    code === undefined ||
    code === null ||
    ["0", "00", "200"].includes(String(code))
  );
}

function asPosting(value: unknown): AlioPosting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as AlioPosting;
}

export function unwrapListResult(result: unknown): AlioPosting[] {
  const values = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as JsonObject).item)
      ? ((result as JsonObject).item as unknown[])
      : result && typeof result === "object" && (result as JsonObject).item
        ? [(result as JsonObject).item]
        : [];

  return values.flatMap((value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const wrapped = (value as JsonObject).item;
      const posting = asPosting(wrapped ?? value);
      return posting ? [posting] : [];
    }

    return [];
  });
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class AlioClient {
  private async request(
    path: "list" | "detail",
    parameters: Record<string, string>,
  ): Promise<AlioApiResponse> {
    if (!env.alioServiceKey) {
      throw new Error("필수 환경변수 ALIO_SERVICE_KEY가 없습니다.");
    }

    const url = new URL(
      `${env.alioApiBaseUrl.replace(/\/$/, "")}/${path}.do`,
    );
    url.searchParams.set("serviceKey", env.alioServiceKey);
    url.searchParams.set("resultType", "json");

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= env.requestRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            swaggerType: "Y",
          },
          signal: AbortSignal.timeout(env.requestTimeoutMs),
        });

        if (!response.ok) {
          throw new HttpError(
            `알리오 API HTTP 오류: ${response.status}`,
            response.status,
          );
        }

        const body = (await response.json()) as AlioApiResponse;

        if (!isSuccessCode(body.resultCode)) {
          throw new Error(
            `알리오 API 오류 ${String(body.resultCode)}: ${body.resultMsg ?? "메시지 없음"}`,
          );
        }

        return body;
      } catch (error) {
        lastError = error;
        const retryable =
          !(error instanceof HttpError) ||
          error.status === 429 ||
          error.status >= 500;

        if (!retryable || attempt >= env.requestRetries) {
          break;
        }

        const waitMs = 500 * 2 ** attempt;
        logger.warn("알리오 API 호출 재시도", {
          path,
          attempt: attempt + 1,
          waitMs,
        });
        await delay(waitMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("알리오 API 호출에 실패했습니다.");
  }

  async fetchPostings(
    filters: AlioListFilters = {},
  ): Promise<AlioListResult> {
    const postings = new Map<string, AlioPosting>();
    let pageNo = 1;
    let totalCount = 0;
    let receivedCount = 0;
    const pageSignatures = new Set<string>();

    while (true) {
      const body = await this.request("list", {
        ...filters,
        pageNo: String(pageNo),
        numOfRows: String(env.pageSize),
      });
      const pageItems = unwrapListResult(body.result);
      const pageTotal = Number(body.totalCount ?? 0);

      if (Number.isFinite(pageTotal) && pageTotal >= 0) {
        totalCount = pageTotal;
      }

      receivedCount += pageItems.length;
      const pageSignature = pageItems
        .map((item) => String(item.recrutPblntSn ?? ""))
        .join(",");

      if (pageItems.length > 0 && pageSignatures.has(pageSignature)) {
        throw new Error(
          `알리오 API가 같은 페이지를 반복해서 반환했습니다. pageNo=${pageNo}`,
        );
      }
      pageSignatures.add(pageSignature);

      for (const item of pageItems) {
        const id = item.recrutPblntSn;
        if (id !== null && id !== undefined) {
          postings.set(String(id), item);
        }
      }

      logger.info("알리오 목록 페이지 수집", {
        pageNo,
        pageItems: pageItems.length,
        receivedCount,
        totalCount,
        filters,
      });

      if (
        pageItems.length === 0 ||
        (totalCount > 0 && receivedCount >= totalCount) ||
        (totalCount === 0 && pageItems.length < env.pageSize)
      ) {
        break;
      }

      pageNo += 1;
    }

    if (totalCount > 0 && postings.size < totalCount) {
      throw new Error(
        `알리오 페이지 수집이 불완전합니다. expected=${totalCount}, unique=${postings.size}, received=${receivedCount}`,
      );
    }

    return {
      items: [...postings.values()],
      totalCount,
    };
  }

  async fetchActivePostings(): Promise<AlioListResult> {
    return this.fetchPostings({ ongoingYn: "Y" });
  }

  async fetchDetail(sourcePostingId: string): Promise<AlioPosting> {
    const body = await this.request("detail", { sn: sourcePostingId });
    const result =
      body.result &&
      typeof body.result === "object" &&
      !Array.isArray(body.result) &&
      (body.result as JsonObject).item
        ? (body.result as JsonObject).item
        : body.result;
    const posting = asPosting(result);

    if (!posting) {
      throw new Error(
        `알리오 상세 응답 형식이 올바르지 않습니다. sn=${sourcePostingId}`,
      );
    }

    return posting;
  }
}
