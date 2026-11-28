/**
 * 需求域（需求详情、用户故事详情、RMP 文档正文）外链路由器。
 */

/**
 * 基于已安全清洗的 `join(subPath)` 构造需求域外链方法。
 *
 * @param {(subPath: string) => string} join
 */
export function buildRequirementLinks(join) {
  return Object.freeze({
    requirementUrl(id) {
      const clean = String(id ?? '').trim();
      return clean ? join(`/dop/asd/requirement?id=${encodeURIComponent(clean)}`) : '';
    },
    storyUrl(id) {
      const clean = String(id ?? '').trim();
      return clean ? join(`/dop/asd/storyDetail?id=${encodeURIComponent(clean)}`) : '';
    },
    rmpDocUrl(docId) {
      const clean = String(docId ?? '').trim();
      return clean
        ? join(`/rdp/vpgatway/vrmprovider/rms/api/viewDocContent?docId=${encodeURIComponent(clean)}`)
        : '';
    },
  });
}
