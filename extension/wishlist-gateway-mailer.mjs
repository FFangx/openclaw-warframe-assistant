// Gateway 愿望命中 Outbox 投递器（整改 R3 第四片：愿望主动命中通知迁移共享 Outbox）。
//
// 把 QQ outbound adapter 的 sendMedia/sendText 结果转换为固定脱敏类别，供共享
// Outbox 逐 part 持久化（结果立即落盘、重试只补投失败的 part）。
// - 服务端明确接受（返回 messageId）→ { ok: true, category: null }；
// - adapter 返回 error → { ok: false, category: 'provider_rejected' }；
// - adapter 未返回 messageId → { ok: false, category: 'missing_message_id' }；
// - adapter 抛异常 → { ok: false, category: 'adapter_exception' }（原始异常不落盘）；
// - adapter 缺配套方法 → { ok: false, category: 'adapter_unsupported' }。
// 本模块零网络、零账号访问：adapter/target/common 全部由调用方注入（可测试）。

export function createGatewayWishlistMailer(adapter, target, common = {}) {
  return async function wishlistGatewayMailer(part) {
    const base = { ...(common || {}), to: String(target || '') };
    if (!base.to) return { ok: false, category: 'missing_target' };
    let result;
    try {
      if (part?.kind === 'media') {
        if (typeof adapter?.sendMedia !== 'function') return { ok: false, category: 'adapter_unsupported' };
        result = await adapter.sendMedia({ ...base, text: '', mediaUrl: part.value });
      } else {
        if (typeof adapter?.sendText !== 'function') return { ok: false, category: 'adapter_unsupported' };
        result = await adapter.sendText({ ...base, text: String(part?.value ?? '') });
      }
    } catch {
      return { ok: false, category: 'adapter_exception' };
    }
    if (result?.error) return { ok: false, category: 'provider_rejected' };
    if (!result?.messageId) return { ok: false, category: 'missing_message_id' };
    return { ok: true, category: null };
  };
}
