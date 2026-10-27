#!/usr/bin/env node
/** Synthetic, local-only CLI process. No HTTP, credentials, logging or writes. */
const [area, verb, id, flag, ...extra] = process.argv.slice(2);
if (area !== 'change' || verb !== 'view' || id !== 'DEMO100001' || flag !== '-j' || extra.length) process.exit(2);
const scenario = process.env.HELUO_DEMO_CASE ?? 'success';
if (scenario === 'denied') { console.error('HTTP 403 synthetic denial'); process.exit(1); }
if (scenario === 'malformed') { console.log('synthetic non-JSON response'); process.exit(0); }
if (scenario === 'timeout') { setInterval(() => {}, 1000); }
else console.log(JSON.stringify({
  id, title: '图书借阅 · 到期提醒', status: 'open',
  description: '读者希望在借阅到期前收到提醒。本次变更为借阅详情增加到期日期和剩余天数，避免因忘记归还产生逾期。只展示到期信息，不改动借阅记录或还书状态。',
  acceptance_criteria: [
    '在借阅详情展示原平台返回的到期日期与剩余天数。',
    '到期当天展示“今日到期”，已经逾期时明确提示逾期。',
    '无权限用户不能读取他人的借阅详情。',
    '查询不会修改借阅状态、归还时间或读者资料。',
  ],
  sub_systems: [{ code: 'DEMO.library', name: '图书借阅示例子系统' }],
  user_stories: [
    { code: 'US-DEMO-1', title: '查看借阅详情', release_info: null },
    { code: 'US-DEMO-2', title: '到期提醒', release_info: { release_num: 'REL-DEMO-1', release_name: '借阅体验改进' } },
  ],
}));
