const CURRENT_COMMAND_SCOPES = Object.freeze({
  fissure: 'current_worldstate', arbitration: 'current_worldstate', alert: 'current_worldstate',
  invasion: 'current_worldstate', event: 'current_worldstate', sortie: 'current_day',
  incursion: 'current_day', trader: 'current_worldstate', bounty: 'current_rotation',
  weekly: 'current_week', account: 'local_snapshot', shop: 'current_rotation',
  'weekly-deals': 'current_week', 'rotation-calendar': 'scheduled_rotation',
  recommend: 'current_worldstate_and_snapshot', refine: 'local_snapshot_and_market',
  'ducat-plan': 'local_snapshot_and_market', 'trader-shopping': 'current_worldstate_and_snapshot',
  rivens: 'local_snapshot_and_market', market: 'current_market',
});

const STATIC_COMMANDS = new Set(['relic', 'where-to-buy', 'help']);
const STATIC_LOOKUPS = new Set(['dict', 'drops', 'recipe', 'vendor', 'item']);

function firstWord(value) {
  return String(value || '').trim().split(/\s+/u)[0] || '';
}

export function buildEvidenceEnvelope(result, operation = 'command', query = '') {
  const facts = result?.facts || null;
  const kind = String(result?.kind || '').trim();
  const lookupKind = firstWord(query);
  let scope = 'unknown';
  let evidenceType = 'unclassified';

  if (operation === 'lookup') {
    if (lookupKind === 'worldstate') scope = 'current_worldstate';
    else if (lookupKind === 'bounties') scope = 'current_rotation';
    else if (lookupKind === 'sp-incursions') scope = 'current_day';
    else if (STATIC_LOOKUPS.has(lookupKind)) scope = 'static_reference';
    evidenceType = scope === 'static_reference' ? 'reference' : 'direct_snapshot';
  } else if (operation === 'subscription') {
    scope = 'subscription_ledger';
    evidenceType = 'local_state';
  } else if (facts?.type === 'bounty-reward-current-check' || facts?.type === 'bounty-place') {
    scope = 'current_rotation';
    evidenceType = 'direct_snapshot';
  } else if (CURRENT_COMMAND_SCOPES[kind]) {
    scope = CURRENT_COMMAND_SCOPES[kind];
    evidenceType = scope.includes('snapshot') ? 'local_snapshot' : 'direct_snapshot';
  } else if (STATIC_COMMANDS.has(kind)) {
    scope = 'static_reference';
    evidenceType = 'reference';
  }

  const asOf = facts?.fetchedAt || result?.fetchedAt || result?.sourceTimestamp || result?.data?.fetchedAt || null;
  const expiresAt = facts?.expiry || facts?.expiresAt || result?.expiry || result?.expiresAt || result?.data?.expiry || null;
  const expiryMs = Date.parse(String(expiresAt || ''));
  const freshness = Number.isFinite(expiryMs)
    ? (expiryMs > Date.now() ? 'current' : 'expired')
    : (asOf ? 'undated_expiry' : 'unknown');
  let finding = result?.ok === false ? 'unavailable' : 'reported';
  if (facts?.type === 'bounty-reward-current-check') {
    finding = facts.currentlyAvailable === true ? 'confirmed_present' : 'confirmed_absent_in_scope';
  }
  if (freshness === 'expired' && scope !== 'static_reference') finding = 'stale_evidence';

  return {
    scope,
    evidenceType,
    asOf,
    expiresAt,
    freshness,
    finding,
    source: result?.source || null,
    rule: '状态性结论必须由时间、范围、对象均匹配且未过期的直接证据支持；静态资料、历史记录、旧快照、相关性或未覆盖范围不得升级为当前事实。',
  };
}

export const STATE_ASSERTION_POLICY = [
  '凡回答“现在/当前/本轮/今天/本周/仍然/已经/我的”等状态性事实，只能使用本次工具 evidence 中时间、范围和对象都匹配的直接证据。',
  'static_reference 只能证明规则、可能来源或历史归属，不能证明当前出现；旧快照不能证明现在；未覆盖或未知不能表述为不存在。',
  '只有 freshness 不为 expired 且 finding=confirmed_present 才能断言目标当前存在；finding=confirmed_absent_in_scope 只能断言在该证据范围内未命中；stale_evidence 不得用于当前结论。',
  '证据不足、过期或范围不匹配时必须明确说无法确认，并补做对应实时查询；不得利用训练记忆、先前对话或卡片之外的信息补充状态性建议。',
].join(' ');
