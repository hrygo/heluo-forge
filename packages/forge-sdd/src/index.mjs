/**
 * `@heluo/forge-sdd`：交付清单（freeze）的冻结与校验。
 *
 * 这是本地前置校验与 CI 共用的同一规则集实现；本地结论标注"未经 CI 验证"。
 * 路径规则由 `@heluo/forge-policy` 执行，本包只按清单声明判断，不猜业务范围。
 */
export { freeze, loadManifest, verifyManifest } from './freeze.mjs';
export {
  blockingFindings,
  fingerprint,
  inspectManifest,
  MANIFEST_VERSION,
  resolveArtifactPath,
  SddManifestError,
} from './manifest.mjs';
