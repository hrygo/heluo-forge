/** Reserved for trusted skills shipped by forge-enterprise. */
export function isEnterpriseSkillName(name: unknown): boolean {
  return typeof name === 'string' && /^enterprise-/i.test(name.trim());
}

export function reservedSkillError(name: string) {
  return { ok: false as const, code: 'error.enterprise.reserved', error: '该名称由企业流程技能保留，请使用其他名称', params: { name } };
}
