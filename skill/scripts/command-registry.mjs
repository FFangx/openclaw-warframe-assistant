// ESM facade for the synchronous CommonJS registry. The definition remains in
// one file so both runtime scripts and the OpenClaw plugin loader consume it.
import registry from './command-registry.cjs';

export const {
  COMMAND_REGISTRY_SCHEMA_VERSION,
  HELP_SECTION_REGISTRY,
  COMMAND_REGISTRY,
  normalizeCommandText,
  getCommand,
  getHelpSection,
  resolveHelpTopic,
  listHelpSections,
  matchCommandText,
  matchesRegistryRoute,
  isUserPrivateCommand,
  matchWeeklyCommand,
  matchWishlistCommand,
  matchSubscriptionCommand,
  matchIntelCommand,
  directIntelType,
  matchArbitrationCommand,
  buildTemplateCatalog,
  buildHelpSections,
  buildToolCommandSummary,
  registryContractErrors,
} = registry;
