function isEnterpriseSkillName(name) {
  return typeof name === "string" && /^enterprise-/i.test(name.trim());
}
function reservedSkillError(name) {
  return { ok: false, code: "error.enterprise.reserved", error: "\u8BE5\u540D\u79F0\u7531\u4F01\u4E1A\u6D41\u7A0B\u6280\u80FD\u4FDD\u7559\uFF0C\u8BF7\u4F7F\u7528\u5176\u4ED6\u540D\u79F0", params: { name } };
}
export {
  isEnterpriseSkillName,
  reservedSkillError
};
