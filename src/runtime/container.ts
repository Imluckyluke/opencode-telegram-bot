import { existsSync } from "node:fs";

export const OPENCODE_TELEGRAM_CONTAINER_ENV = "OPENCODE_TELEGRAM_CONTAINER";

export interface ContainerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  dockerEnvExists?: () => boolean;
}

function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  // Explicit allowlist, mirroring getOptionalBooleanEnvVar: anything else
  // (including "off", "disabled", "n") means disabled, never enabled.
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isContainerRuntime(options?: ContainerRuntimeOptions): boolean {
  const env = options?.env ?? process.env;
  if (isEnabledFlag(env[OPENCODE_TELEGRAM_CONTAINER_ENV])) {
    return true;
  }

  const dockerEnvExists = options?.dockerEnvExists ?? (() => existsSync("/.dockerenv"));
  return dockerEnvExists();
}
