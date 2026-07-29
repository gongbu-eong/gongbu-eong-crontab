import assert from "node:assert/strict";
import test, { before } from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.ALIO_SERVICE_KEY = "test-service-key";
process.env.ALIO_API_BASE_URL =
  "https://opendata.alio.go.kr/new/v1/recruit";
process.env.ALIO_PAGE_SIZE = "2";
process.env.ALIO_MIN_EXPECTED_ROWS = "1";
process.env.ALIO_REQUEST_RETRIES = "0";

let AlioClient: typeof import("./client").AlioClient;
let unwrapListResult: typeof import("./client").unwrapListResult;

before(async () => {
  const clientModule = await import("./client");
  AlioClient = clientModule.AlioClient;
  unwrapListResult = clientModule.unwrapListResult;
});

test("목록 응답의 item 래퍼를 제거한다", () => {
  assert.deepEqual(
    unwrapListResult([
      { item: { recrutPblntSn: 1 } },
      { item: { recrutPblntSn: 2 } },
    ]),
    [{ recrutPblntSn: 1 }, { recrutPblntSn: 2 }],
  );
});

test("totalCount까지 목록 페이지를 수집한다", async (context) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: URL[] = [];
  const requestedOptions: RequestInit[] = [];

  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    requestedOptions.push(options ?? {});
    const pageNo = Number(url.searchParams.get("pageNo"));
    const items =
      pageNo === 1
        ? [
            { item: { recrutPblntSn: 1 } },
            { item: { recrutPblntSn: 2 } },
          ]
        : [{ item: { recrutPblntSn: 3 } }];

    return new Response(
      JSON.stringify({
        resultCode: 200,
        resultMsg: "정상",
        totalCount: 3,
        result: items,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const result = await new AlioClient().fetchActivePostings();

  assert.equal(result.items.length, 3);
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].pathname, "/new/v1/recruit/list.do");
  assert.equal(requestedUrls[0].searchParams.get("ongoingYn"), "Y");
  assert.equal(
    requestedUrls[0].searchParams.get("serviceKey"),
    "test-service-key",
  );
  assert.equal(requestedOptions[0].method, "POST");
  assert.equal(
    new Headers(requestedOptions[0].headers).get("swaggerType"),
    "Y",
  );
});
