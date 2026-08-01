/**
 * POST-ICP-COMPLIANCE — public site compliance configuration.
 *
 * These values are intentionally public: the ICP filing number and the
 * Ministry of Industry and Information Technology (MIIT) record URL are
 * required by Chinese law to appear on every page of a publicly hosted
 * service. They are not secrets.
 *
 * DO NOT put personal material here (no ID card, phone number, home
 * address, ICP application order id, screenshots, or payment records).
 *
 * The public security bureau (公安部) network record is NOT yet filed.
 * Once issued, set `publicSecurityNumber` to the issued number and
 * `publicSecurityUrl` to the record lookup URL. The footer renders the
 * police record block ONLY when `publicSecurityNumber` is non-empty.
 *
 * Source for ICP number: confirmed ICP filing for this service.
 */

export const SITE_COMPLIANCE = {
  icpNumber: "京ICP备2026029682号",
  icpUrl: "https://beian.miit.gov.cn/",
  publicSecurityNumber: "",
  publicSecurityUrl: "",
} as const;

export type SiteCompliance = typeof SITE_COMPLIANCE;