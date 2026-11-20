/**
 * Plain words for why a model test or a model list failed. The relay passes the
 * provider's own message through (often English, an HTTP status and a JSON
 * body); the app shows this sentence first and the original underneath.
 * The desktop app uses the same wording.
 */
export interface ModelErrorText {
  /** One short sentence: what went wrong, in the person's terms. */
  title: string;
  /** What the provider said, for whoever needs it; empty when it adds nothing. */
  detail: string;
}

const RULES: { test: RegExp; title: string }[] = [
  { test: /HTTP 40[13]\b|\b40[13]\)|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|permission denied|密钥/i, title: "密钥不对，或这个密钥没有权限" },
  { test: /HTTP 404\b|\b404\)|model[ _-]?not[ _-]?found|does not exist|no such model|没有这个模型|not found/i, title: "地址或模型名不对，服务商找不到它" },
  { test: /HTTP 429\b|\b429\)|rate[ _-]?limit|too many requests|quota|insufficient|balance|余额|额度|限流/i, title: "被限流了，或额度用完了" },
  { test: /HTTP 5\d\d\b|overloaded|bad gateway|service unavailable|internal server error/i, title: "服务商那边出错了，过会儿再试" },
  { test: /no answer in time|timed? ?out|timeout|超时|aborted/i, title: "等太久没回话" },
  { test: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|getaddrinfo|fetch failed|network|certificate|self[- ]signed|socket hang up/i, title: "连不上这个地址" },
  { test: /empty answer/i, title: "它回了空话" },
  { test: /HTTP 400\b|\b400\)|bad request|invalid/i, title: "服务商不接受这个请求，多半是模型名或参数不对" },
];

export function modelErrorText(raw: string | null | undefined): ModelErrorText {
  const text = (raw ?? "").trim();
  if (!text) return { title: "没有回话", detail: "" };
  const hit = RULES.find((r) => r.test.test(text));
  if (!hit) return { title: "没通", detail: text };
  return { title: hit.title, detail: text };
}
