import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 源码测试和已安装运行时的目录层级不同，但二者都只加载 skill 中的唯一注册表。
// 不在 extension 目录复制命令定义，避免路由、帮助和工具说明再次漂移。
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const registryCandidates = [
  path.resolve(extensionDir, '..', 'skill', 'scripts', 'command-registry.mjs'),
  path.resolve(extensionDir, '..', '..', '..', 'skills', 'warframe-assistant', 'scripts', 'command-registry.mjs'),
];
const registryPath = registryCandidates.find((candidate) => existsSync(candidate));
if (!registryPath) throw new Error('Warframe command registry was not found');
const registry = await import(pathToFileURL(registryPath).href);

export const COMMAND_REGISTRY = registry.COMMAND_REGISTRY;
const normalize = registry.normalizeCommandText;

export function isPersonalAccountCommand(content) {
  return registry.isUserPrivateCommand(normalize(content));
}

export function isWeeklyCommand(content) {
  return Boolean(registry.matchWeeklyCommand(normalize(content)));
}

export function directIntelType(content) {
  return registry.directIntelType(normalize(content));
}

export function isArbitrationShortcut(content) {
  return Boolean(registry.matchArbitrationCommand(normalize(content)));
}

export function isSubscriptionCommand(content) {
  return Boolean(registry.matchSubscriptionCommand(normalize(content)));
}

export function isWishlistCommand(content) {
  return Boolean(registry.matchWishlistCommand(normalize(content)));
}

export function isShortcut(content) {
  return registry.matchesRegistryRoute(normalize(content), 'shortcut-gate');
}

export function commandToolSummary() {
  return registry.buildToolCommandSummary();
}
