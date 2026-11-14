/**
 * The environment a deploy script of this folder runs in as a launcher's child (the mainnet deployer's execute, the
 * public-testnet launcher): the shell's, without any KUSDT_* variable and without DEPLOY_CONFIG, then what the
 * launcher sets. scripts/deploy.ts lets a KUSDT_* variable override its config file (for deploys by hand), and there
 * the config file is the launcher's plan: a KUSDT_GUARDIAN or KUSDT_SIGNERS left in the shell would deploy a vault that
 * is not the one planned. Names are compared without regard to case, as Windows reads them. It imports nothing.
 */
export function childEnv(shell: Record<string, string | undefined>, set: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(shell)) {
    const upper = name.toUpperCase();
    if (value === undefined || upper.startsWith("KUSDT_") || upper === "DEPLOY_CONFIG") continue;
    env[name] = value;
  }
  return { ...env, ...set };
}
