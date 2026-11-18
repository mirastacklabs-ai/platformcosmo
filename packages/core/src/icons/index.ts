/** Icon system entry points (Track C). */
export { sanitizeSvg } from "./sanitize.js";
export { createIconResolver, iconRejections, iconCost } from "./resolver.js";
export {
  fetchIconPack,
  checkHttpsUrl,
  readZipDirectory,
  derivePackSource,
  FETCH_LIMITS,
  PACK_ID_RE,
  PROVIDER_IDS,
  PROVIDER_TERMS,
} from "./fetch.js";
export { computeIconIntegrity, verifyIconIntegrity, sha256, canonicalJson } from "./integrity.js";
