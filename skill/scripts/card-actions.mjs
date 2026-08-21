function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export const NEXT_ACTIONS_HEIGHT = 36;

export function renderNextActions(actions) {
  const safe = (Array.isArray(actions) ? actions : []).filter((item) => item?.command).slice(0, 2);
  if (!safe.length) return '';
  return `<div style="height:${NEXT_ACTIONS_HEIGHT}px;padding:0 14px;display:flex;align-items:center;gap:8px;border-top:1px solid rgba(176,123,55,.30);background:rgba(15,19,23,.34);font-size:11px;color:#8995a1"><span style="font-weight:800;color:#aeb9c4">下一步</span>${safe.map((item) => `<span style="padding:3px 7px;border:1px solid #46515b;border-radius:6px;color:#cdd7df">${escapeHtml(item.command)}</span>`).join('')}</div>`;
}
