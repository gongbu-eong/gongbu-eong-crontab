export type JsonObject = Record<string, unknown>;

export interface AlioFile extends JsonObject {
  atchFileNm?: string | null;
  atchFileType?: string | null;
  recrutAtchFileNo?: string | number | null;
  sortNo?: string | number | null;
  url?: string | null;
}

export interface AlioStep extends JsonObject {
  recrutStepSn?: string | number | null;
  recrutPbancTtl?: string | null;
  sortNo?: string | number | null;
  rsnOcrnYmd?: string | null;
}

export interface AlioPosting extends JsonObject {
  acbgCondLst?: string | null;
  acbgCondNmLst?: string | null;
  aplyQlfcCn?: string | null;
  decimalDay?: string | number | null;
  disqlfcRsn?: string | null;
  files?: unknown;
  hireTypeLst?: string | null;
  hireTypeNmLst?: string | null;
  instNm?: string | null;
  ncsCdLst?: string | null;
  ncsCdNmLst?: string | null;
  nonatchRsn?: string | null;
  ongoingYn?: string | null;
  pbadmsStdInstCd?: string | null;
  pbancBgngYmd?: string | null;
  pbancEndYmd?: string | null;
  pblntInstCd?: string | null;
  prefCn?: string | null;
  prefCondCn?: string | null;
  recrutNope?: string | number | null;
  recrutPbancTtl?: string | null;
  recrutPblntSn?: string | number | null;
  recrutSe?: string | null;
  recrutSeNm?: string | null;
  replmprYn?: string | null;
  scrnprcdrMthdExpln?: string | null;
  srcUrl?: string | null;
  steps?: unknown;
  workRgnLst?: string | null;
  workRgnNmLst?: string | null;
}

export interface AlioApiResponse {
  result?: unknown;
  resultCode?: string | number;
  resultMsg?: string;
  totalCount?: string | number;
}

export interface AlioListResult {
  items: AlioPosting[];
  totalCount: number;
}

export interface AlioListFilters {
  ongoingYn?: "Y" | "N";
  pbancBgngYmd?: string;
  pbancEndYmd?: string;
}

export interface NormalizedAlioPosting {
  sourcePostingId: string;
  institutionCode: string;
  institutionName: string;
  title: string;
  ncsCategory: string | null;
  jobCategory: string | null;
  workRegion: string | null;
  employmentType: string | null;
  hiringCount: number | null;
  educationRequirement: string | null;
  careerRequirement: string | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  announcementAt: string | null;
  applyUrl: string | null;
  qualification: string | null;
  disqualification: string | null;
  preference: string | null;
  screeningProcess: string | null;
  applicationMethod: string | null;
  additionalNotice: string | null;
  contentHash: string;
  rawPayload: {
    list: AlioPosting;
    detail: AlioPosting | null;
  };
  isActive: boolean;
  detailFetched: boolean;
  files: AlioFile[];
  steps: AlioStep[];
}
