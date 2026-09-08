// R17 第一片：QQ 插件侧的脱敏 trace 桥梁。
//
// 只服务代表链「裂缝 九重天」：本桥负责 QQ 入口的 received / authorization / delivery 三段，
// 与 skill 侧 shortcuts.mjs 子进程记录的 route / facts / decision / render 共享同一 traceId
// （经 WARFRAME_TRACE_STORE / WARFRAME_TRACE_ID / WARFRAME_TRACE_TRIGGER 环境变量串起）。
// 信封实现（12 字段白名单、容量有界、原子、fail-open）全部复用 skill/scripts/trace.mjs，
// 本桥只做插件侧组装：目标文本精确门、触发点命名、身份门类别与 QQ 直投结果类别映射。
//
// 永不写入：QQ target/发送者/用户原话/查询文本、个人快照、订单/卖家身份、完整工具结果、
// URL、响应体、堆栈；隐私范围只以 privacyScopeHash（sha256('public'|'personal') 前 16 位）呈现。

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
// 源码测试与已安装运行时的目录层级不同（与 routing.mjs 同款解析），
// 信封与存储实现只在 skill 树维护一份。
const traceModuleCandidates = [
  path.resolve(extensionDir, '..', 'skill', 'scripts', 'trace.mjs'),
  path.resolve(extensionDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'trace.mjs'),
];
const traceModulePath = traceModuleCandidates.find((candidate) => existsSync(candidate));
if (!traceModulePath) throw new Error('warframe trace.mjs was not found');

let traceModulePromise = null;
export function traceModule() {
  traceModulePromise ||= import(pathToFileURL(traceModulePath).href);
  return traceModulePromise;
}

export const QQ_TRACE_TRIGGERS = Object.freeze([
  'qq-before-dispatch',
]);

// 目标文本门：委托 skill 侧单一实现（与注册表归一规则一致，避免两侧判定漂移）。
export async function isTraceTarget(text) {
  const module = await traceModule();
  return module.isRepresentativeChain(text);
}

export async function createQqTraceContext({ storePath, triggerType = 'qq-before-dispatch' } = {}) {
  const module = await traceModule();
  return {
    storePath: String(storePath || '').trim(),
    traceId: module.newTraceId(),
    triggerType: QQ_TRACE_TRIGGERS.includes(triggerType) ? triggerType : 'qq-unknown',
    module,
  };
}

// 记录一个插件侧阶段；任何失败只返回 false（fail-open），绝不阻断主业务。
// fields 可带 scope（'public'|'personal'，仅用于计算 privacyScopeHash，本身绝不落盘）。
export async function recordQqTraceStage(ctx, fields = {}) {
  try {
    if (!ctx || !ctx.storePath || !ctx.traceId) return false;
    const record = {
      traceId: ctx.traceId,
      triggerType: ctx.triggerType,
      commandId: 'fissure',
      privacyScopeHash: fields.scope ? ctx.module.privacyScopeHash(fields.scope) : '',
      stage: fields.stage,
      startedAt: fields.startedAt,
      durationMs: fields.durationMs,
      source: fields.source,
      freshness: fields.freshness,
      resultCategory: fields.resultCategory,
      retryCount: fields.retryCount,
      contentHash: fields.contentHash,
    };
    const store = ctx.module.createTraceStore({ filePath: ctx.storePath });
    return await store.append(record);
  } catch {
    return false;
  }
}

// 身份门结果类别：本代表链为公开命令，实际只会出现 public；personal 仅在防回归测试中可见。
export function authorizationResultCategory(personalAllowed, isGroup) {
  return personalAllowed === true && isGroup !== true
    ? 'allowed-personal-enhancement'
    : 'allowed-public';
}

// QQ 直投适配器结果 → 固定脱敏类别（服务端明确接受/拒绝/适配器不可用；原始异常不落盘）。
export function deliveryResultCategory(result, adapterAvailable = true) {
  if (adapterAvailable === false) return 'adapter-unavailable';
  return result?.error ? 'rejected' : 'accepted';
}

// 已投递媒体文件的内容指纹（只存哈希，不存路径/内容；读取失败返回空串）。
export async function contentHashOfFile(filePath) {
  try {
    const buffer = await readFile(String(filePath || ''));
    return createHash('sha256').update(buffer).digest('hex');
  } catch {
    return '';
  }
}
