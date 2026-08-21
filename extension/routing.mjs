const normalize = (value) => String(value || '').normalize('NFKC').trim();

export function isPersonalAccountCommand(content) {
  const text = normalize(content).replace(/^\//u, '');
  if (/^(?:我有|我的库存|我的遗物).*(?:这些|那些|它们|上面(?:这些|那些)?|刚才(?:这些|那些)?)/u.test(text)) return false;
  return /^(?:我的账号|账号状态|我的状态|账号周常|我的周常状态|周常同步状态|刷新账号|刷新库存)$/u.test(text)
    || /^(?:开遗物|遗物推荐|开什么遗物|开什么)(?:\s+.*)?$/u.test(text)
    || /^(?:精炼推荐|遗物精炼|值得精炼|精炼什么)(?:\s+\S+){0,2}$/u.test(text)
    || /^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\s+.*)?$/u.test(text)
    || /^(?:奸商推荐|奸商买什么|奸商购物|虚空商人推荐|虚空商人买什么)$/u.test(text)
    || /^商店(?:\s+\S+)?$/u.test(text)
    || /^(?:本周好货|好货|好货清单)$/u.test(text)
    || /^(?:轮换日历|排期|日历|未来轮换)$/u.test(text)
    || /^(?:我的紫卡|紫卡列表|紫卡)(?:\s+\S+)*$/u.test(text)
    || /^(?:我的遗物|我的赋能|我的库存)(?:\s+.*)?$/u.test(text);
}

export function isWeeklyCommand(content) {
  const text = normalize(content).replace(/^\//u, '');
  return /^(?:周常|当前周常|周常清单|周常列表|本周周常|周报|周常帮助|清空周常)$/u.test(text)
    || /^(?:完成|撤销|跳过|取消跳过)\s+\S.*$/u.test(text);
}

export function isArbitrationShortcut(content) {
  return /^\/?(?:仲裁|当前仲裁)$/u.test(normalize(content));
}

export function directIntelType(content) {
  const text = normalize(content).replace(/^\//u, '');
  if (text === '警报' || text === '当前警报') return 'alert';
  if (text === '入侵' || text === '当前入侵') return 'invasion';
  if (text === '活动' || text === '当前活动') return 'event';
  if (text === '虚空商人' || text === '奸商' || text === '当前虚空商人') return 'trader';
  if (text === '突击' || text === '当前突击' || text === '今日突击') return 'sortie';
  if (text === '钢铁侵袭' || text === '钢铁之路侵袭' || text === '今日钢铁侵袭' || text === '侵袭') return 'incursion';
  return null;
}

export function isSubscriptionCommand(content) {
  const text = normalize(content).replace(/^\//u, '');
  return /^(?:订阅|提醒|我的订阅|订阅列表|我的提醒|取消订阅|取消提醒|暂停订阅|暂停提醒|恢复订阅|恢复提醒|订阅帮助|提醒帮助)(?:\s*.*)?$/u.test(text);
}

export function isShortcut(content) {
  const text = normalize(content);
  return /^\/?wm(?![a-z])/iu.test(text)
    || /^\/?遗物(?:\s+|$)/u.test(text)
    || /^\/?(?:哪里刷|怎么刷|获取路线)(?:\s*.*)?$/u.test(text)
    || /^\/?\S.{0,30}(?:哪里刷|怎么刷)[？?！!。.\s]*$/u.test(text)
    || /^\/?(?:裂缝推荐|推荐裂缝)(?:\s+|$)/u.test(text)
    || /^\/?(?:(?:钢铁|普通|全能|安魂)(?:虚空)?|虚空)?裂缝(?:\s+|$)/iu.test(text)
    || /^\/?(?:帮助|help|菜单|功能|功能列表|命令列表|使用说明|说明书|怎么用)$/iu.test(text)
    || /^\/?哪里买(?:\s+|$)/u.test(text)
    || /^\/?(?:悬赏|赏金)(?:\s+|$)/u.test(text)
    || isArbitrationShortcut(text)
    || isPersonalAccountCommand(text)
    || isWeeklyCommand(text)
    || Boolean(directIntelType(text));
}
