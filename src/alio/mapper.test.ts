import assert from "node:assert/strict";
import test from "node:test";

import {
  koreaDateToIso,
  normalizePosting,
  postingContentHash,
} from "./mapper";

const posting = {
  recrutPblntSn: 123,
  recrutPbancTtl: "테스트 채용",
  instNm: "테스트 기관",
  pblntInstCd: "I001",
  pbancBgngYmd: "20260729",
  pbancEndYmd: "2026-08-05",
  recrutNope: "1,234",
  ongoingYn: "Y",
  decimalDay: 7,
};

test("한국 날짜를 timestamptz 입력값으로 변환한다", () => {
  assert.equal(
    koreaDateToIso("20260729"),
    "2026-07-29T00:00:00.000+09:00",
  );
  assert.equal(
    koreaDateToIso("2026-08-05", true),
    "2026-08-05T23:59:59.999+09:00",
  );
});

test("D-day가 바뀌어도 공고 내용 해시는 유지된다", () => {
  assert.equal(
    postingContentHash(posting),
    postingContentHash({ ...posting, decimalDay: 6 }),
  );
});

test("알리오 필드를 DB 저장 모델로 변환한다", () => {
  const normalized = normalizePosting(posting, null);

  assert.equal(normalized.sourcePostingId, "123");
  assert.equal(normalized.institutionCode, "I001");
  assert.equal(normalized.hiringCount, 1234);
  assert.equal(normalized.isActive, true);
  assert.equal(
    normalized.applicationEndAt,
    "2026-08-05T23:59:59.999+09:00",
  );
});

test("종료 공고는 비활성 상태로 변환한다", () => {
  assert.equal(
    normalizePosting({ ...posting, ongoingYn: "N" }, null).isActive,
    false,
  );
});

test("진행 상태는 상세가 아닌 목록 응답을 기준으로 판단한다", () => {
  assert.equal(
    normalizePosting(posting, { ...posting, ongoingYn: "N" }).isActive,
    true,
  );
});
