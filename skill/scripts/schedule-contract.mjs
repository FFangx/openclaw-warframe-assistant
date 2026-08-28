// R5 调度合同：集中记录跨脚本、文档与 cron 声明必须保持一致的时间规则。
export const SCHEDULE_CONTRACT = Object.freeze({
  worldstate: Object.freeze({ notDueOutput: 'NO_REPLY', networkBeforeDue: false, unpredictableMs: 15 * 60_000, wakeOffsetMs: 10_000 }),
  wishlist: Object.freeze({ calibrationMs: 10 * 60_000, marketStartSpacingMs: 400 }),
  weekly: Object.freeze({ weekdayUtc: 1, hourUtc: 0, minuteUtc: 0 }),
  rewardZh: Object.freeze({
    declarationKey: 'warframe-assistant:reward-zh-ai:default', scheduleKind: 'every',
    everyMs: 24 * 60 * 60_000, sessionTarget: 'isolated', payloadKind: 'agentTurn',
  }),
});

const DOC_FACTS = Object.freeze([
  'scheduled 记录 `nextCheckAt`', '未到点只读本地状态输出 `NO_REPLY` 不联网',
  '裂缝按最早 expiry', '虚空商人按到达/离开边界', '10 分钟命令型 cron',
  'REST 请求起点至少相隔 400ms', '每周一 00:00 UTC 刷新',
  '每日一条 agent 型 cron', 'schedule-contract.mjs',
]);

export function validateScheduleContract(value = SCHEDULE_CONTRACT) {
  const errors = [];
  if (value.worldstate?.networkBeforeDue !== false || value.worldstate?.notDueOutput !== 'NO_REPLY') errors.push('worldstate gate');
  if (value.worldstate?.unpredictableMs !== 15 * 60_000 || value.worldstate?.wakeOffsetMs !== 10_000) errors.push('worldstate boundaries');
  if (value.wishlist?.calibrationMs !== 10 * 60_000) errors.push('wishlist calibration');
  if (value.wishlist?.marketStartSpacingMs < 1000 / 3) errors.push('Market 3 req/s');
  if (value.weekly?.weekdayUtc !== 1 || value.weekly?.hourUtc !== 0 || value.weekly?.minuteUtc !== 0) errors.push('weekly Monday 00:00 UTC');
  const reward = value.rewardZh;
  if (reward?.scheduleKind !== 'every' || reward?.everyMs !== 24 * 60 * 60_000
    || reward?.sessionTarget !== 'isolated' || reward?.payloadKind !== 'agentTurn') errors.push('reward-zh daily agent cron');
  if (errors.length) throw new Error(`调度合同无效: ${errors.join(', ')}`);
  return true;
}

export function scheduleDocViolations(text) {
  return DOC_FACTS.filter((fact) => !String(text).includes(fact));
}

export function validateScheduleDocs(text) {
  const missing = scheduleDocViolations(text);
  if (missing.length) throw new Error(`调度文档漂移: ${missing.join('；')}`);
  return true;
}
