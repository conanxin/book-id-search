export interface S32Config {
  enabled: boolean;
  databaseUrl: string | null;
  privateToken: string | null;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function readS32Config(env: NodeJS.ProcessEnv): S32Config {
  return {
    enabled: env.S32_FEATURES_ENABLED === "true",
    databaseUrl: clean(env.S32_DATABASE_URL),
    privateToken: clean(env.S32_PRIVATE_API_TOKEN),
  };
}
