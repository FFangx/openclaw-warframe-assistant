const TEMPORAL_TERMS = /(?:现在|当前|本轮|这轮|今天|本周|刚才|刚刚|多久|上次|之后|以后|又|再次|第二轮|还没|仍然|已经)/u;
const SUBSCRIPTION_TERMS = /(?:订阅|提醒|通知|推送|漏报|漏推)/u;
const HISTORY_TERMS = /(?:多久|上次|之后|以后|又|再次|第二轮|还没|一直没|没来|轮换|出现过|漏报|漏推|为什么|怎么)/u;

export function classifyNaturalWarframeQuery(input) {
  const text = String(input || '').normalize('NFKC').trim();
  const temporal = TEMPORAL_TERMS.test(text);
  const subscriptionHistory = HISTORY_TERMS.test(text)
    && (SUBSCRIPTION_TERMS.test(text) || /(?:赏金|悬赏).*(?:轮换|出现|来)|(?:轮换|出现).*(?:赏金|悬赏)/u.test(text));
  return {
    temporal,
    subscriptionHistory,
    requiredOperation: subscriptionHistory ? 'subscription_diagnosis' : null,
    staticReferenceSufficient: !temporal && !subscriptionHistory,
  };
}

export const DYNAMIC_QUERY_POLICY = [
  '先识别用户问的是静态规则、当前状态还是历史/故障。',
  '出现现在、当前、本轮、多久、上次、之后、再次、提醒、推送、轮换等语义时，静态掉落表不能单独回答。',
  '订阅历史或漏提醒问题必须调用 subscription_diagnosis；当前状态另调对应 command。',
].join(' ');
