/**
 * Each vault's owner on mainnet: KusdtAccessManager (OpenZeppelin's AccessManager 5.1.0 with
 * `renounceRole` closed and `revokeCanceller` added), with the project Safe as its only admin. The vault itself is unchanged: it is Ownable2Step, and its
 * owner is the manager, so every owner call goes through `manager.execute(vault, data)`, under
 * the rules below. This file holds the whole configuration in one place, for the Hardhat tests,
 * scripts/deploy-access-manager.ts and the mainnet deployer (bridge/devnet/src/mainnet-deploy.ts,
 * which also verifies it on-chain). It imports only `ethers`, never `hardhat`.
 *
 *   role        id  members      execution delay   vault functions
 *   ADMIN        0  the Safe     48 h              (the manager itself: roles, delays, targets)
 *   GOVERNOR     1  the Safe     48 h              setFees, setDepositSurge, setDepositLimits, setReleaseLimits,
 *                                                  reinstateRelease, reinstateRefund,
 *                                                  setPayoutDelay, setSigners, withdrawFees,
 *                                                  transferOwnership
 *   EMERGENCY    2  the Safe     6 h (1 h to 48 h)  setGuardian, unpause, cancelRelease, cancelRefund
 *   PAUSER       3  the Safe     none              pause
 *   CANCELLER    4  cancellers   (none)            none: it is the role guardian of GOVERNOR, EMERGENCY and
 *                                                  GUARDED, so it can cancel their scheduled calls
 *   GUARDED      5  nobody       -                 none on the vault. The manager's own power-adding functions and
 *                                                  `revokeRole` are mapped to it (MANAGER_GUARDED_FUNCTIONS), which
 *                                                  changes one thing only: who may cancel them
 *
 * The Safe schedules a delayed call (`schedule(vault, data, 0)`), waits the delay, then executes
 * it (`execute(vault, data)`); only the account that scheduled it can execute it, and within a
 * week (OpenZeppelin's expiration) of the time it became executable.
 *
 * AccessManager rules worth knowing (read from the 5.1.0 source):
 *  - Every manager operation (grantRole, revokeRole, setRoleGuardian, setGrantDelay,
 *    setTargetFunctionRole, setTargetClosed, labelRole …) needs ADMIN, and an admin's own execution
 *    delay applies to all of them (`_canCallSelf`): with the Safe's 48 h, every change of the
 *    rules, including revoking a canceller, takes 48 h.
 *  - `cancel(caller, target, data)` is allowed to the account that scheduled the call, to any
 *    ADMIN, and to a member of the role guardian of `getTargetFunctionRole(target, selector)`.
 *    For a call on the manager itself that role is ADMIN unless the function is mapped, and ADMIN's
 *    guardian is ADMIN and can't be changed. So the manager's power-adding functions are mapped to
 *    GUARDED, a role with no member whose guardian is CANCELLER. Who may CALL them does not change:
 *    the manager decides that from its own table (`_getAdminRestrictions`), never from this mapping.
 *    Who may CANCEL them does: a canceller now can.
 *  - Trade-off: a rogue canceller can only delay. It can cancel every GOVERNOR / EMERGENCY call
 *    (including an emergency unpause or a new guardian) and every guarded call on the manager, until
 *    the Safe removes it, which takes 48 h and which the canceller can't cancel. In return, one
 *    honest canceller can stop a bad vault call scheduled by a compromised or mistaken Safe, a bad
 *    power-adding call on the manager (`grantRole(GOVERNOR, attacker, 0)`, a function remapped, a
 *    guardian replaced), and the removal of the Safe's own roles.
 *  - Removing a canceller is the one revocation no canceller can cancel, or a rogue one could cancel
 *    its own removal for ever. It has a function of its own, `revokeCanceller(account)`
 *    (KusdtAccessManager), which is mapped to nothing: an ADMIN call of the Safe's 48 h that only an
 *    ADMIN can cancel. `revokeRole` itself IS guarded (round 11, R11-OWN-5). Left unguarded, as it was
 *    at first, it covered the Safe's own roles too: stolen Safe keys could pause a vault, schedule
 *    the removal of the Safe's EMERGENCY, GOVERNOR, PAUSER and ADMIN roles, and 48 h later nobody could
 *    unpause it, ever, with no canceller able to stop that. (A `revokeRole(CANCELLER, x)` still
 *    works, but a canceller can cancel it: the Safe uses `revokeCanceller`.)
 *  - So whoever holds the Safe can add power, or strip the Safe's roles, only once no canceller cancels
 *    it: it must remove every canceller (48 h, in plain sight) or outlast them. What that buys, in
 *    figures (round 12, R12-OWN-3; test/safe-compromise-times.test.ts):
 *      a theft takes 48 h from the cancellers' LAST cancel. The removals and the power-adding call
 *      can be scheduled in the same minute, and a cancelled call can be scheduled again at once. It is
 *      96 h only when a canceller cancels every re-schedule right up to its own removal at hour 48;
 *      a freeze takes one transaction. The Safe pauses with no delay (PAUSER) and may cancel every
 *      unpause scheduled through it (a scheduler cancels its own operations), so a vault stays paused
 *      for as long as someone holds the Safe's keys. The 96 h are what it takes to make the freeze
 *      outlast those keys (the Safe's own roles revoked).
 *    The monitors alert on every OperationScheduled whose target is the manager itself, the removals
 *    of cancellers first.
 *  - The price: when a rogue canceller and something a revocation must undo come together (a role
 *    that a grant nobody cancelled gave away), the Safe needs 48 h to remove the canceller and 48 h
 *    more for the revocation, where it needed 48 h before.
 *  - Lowering an execution delay (`grantRole` again with a smaller delay) takes the 48 h of the
 *    admin call and then the difference again (OpenZeppelin's setback); raising one is
 *    immediate once the admin call executes. A grant delay or a target admin delay change
 *    takes at least 5 days (`minSetback`). Grant delays and target admin delays stay 0 here:
 *    the Safe's 48 h admin delay already applies to every grant and target change.
 *  - Vault functions not mapped here (e.g. acceptOwnership) stay ADMIN-only, with the 48 h.
 *  - ADMIN does not bypass the roles: the Safe calls setSigners as GOVERNOR, not as ADMIN.
 *  - Nobody can renounce a role (KusdtAccessManager): OpenZeppelin's `renounceRole` takes no delay,
 *    so the Safe could pause and give up EMERGENCY and ADMIN in one transaction, and the vault
 *    would stay paused for ever. A role ends through `revokeRole`, an ADMIN call: the Safe's 48 h,
 *    during which a canceller can cancel it.
 *  - The deployer deploys the manager as its first admin (no delay), deploys the vault with the
 *    manager as owner, then in one transaction (`multicall`) grants the roles, maps the vault's
 *    functions and gives up ADMIN (`revokeRole`, with no delay of its own): it ends with no role at all.
 */
import { Interface, getAddress, id, ZeroAddress } from "ethers";

export const HOUR = 3_600;
export const ROLES = { ADMIN: 0n, GOVERNOR: 1n, EMERGENCY: 2n, PAUSER: 3n, CANCELLER: 4n, GUARDED: 5n } as const;
export type RoleName = keyof typeof ROLES;
export const ROLE_NAMES: RoleName[] = ["ADMIN", "GOVERNOR", "EMERGENCY", "PAUSER", "CANCELLER", "GUARDED"];
/** The Safe's execution delays (seconds). EMERGENCY's comes from the inputs. */
export const ADMIN_DELAY = 48 * HOUR;
export const GOVERNOR_DELAY = 48 * HOUR;
export const PAUSER_DELAY = 0;
export const EMERGENCY_DELAY = { default: 6 * HOUR, min: HOUR, max: 48 * HOUR };
/** OpenZeppelin 5.1.0's fixed values: a scheduled call expires a week after it is ready; delay changes wait 5 days. */
export const OZ_EXPIRATION = 7 * 24 * HOUR;
export const OZ_MIN_SETBACK = 5 * 24 * HOUR;

/**
 * Whether `getCode`'s answer is a contract's code, the rule wherever a vault's owner or a Safe must be a contract (the
 * mainnet deployer, scripts/deploy.ts, scripts/deploy-access-manager.ts). An account delegated under EIP-7702 has code
 * too (0xef0100 + the delegate's address), and is still one key.
 */
export const isContractCode = (code: string) => code !== "0x" && !code.toLowerCase().startsWith("0xef0100");

/** Which role may call each of the vault's owner functions through the manager. */
/**
 * The manager's own functions that add power: granting a role, moving a role's admin or guardian, mapping a
 * function, closing a target, changing a delay or an authority. And `revokeRole`: taking the Safe's own roles away
 * leaves a paused vault with nobody to unpause it. Mapped to GUARDED so that a canceller can cancel one the Safe has
 * scheduled. Not here, on purpose: `revokeCanceller` (removing a canceller must not be cancellable by a canceller;
 * see MANAGER_ADMIN_ONLY_FUNCTIONS) and `labelRole` (a name).
 */
export const MANAGER_GUARDED_FUNCTIONS = [
  "grantRole(uint64,address,uint32)",
  "revokeRole(uint64,address)",
  "setRoleAdmin(uint64,uint64)",
  "setRoleGuardian(uint64,uint64)",
  "setGrantDelay(uint64,uint32)",
  "setTargetAdminDelay(address,uint32)",
  "setTargetFunctionRole(address,bytes4[],uint64)",
  "setTargetClosed(address,bool)",
  "updateAuthority(address,address)",
];

/**
 * The manager's functions that must stay mapped to nothing (ADMIN, whose guardian is ADMIN): a canceller can't cancel
 * them. `revokeCanceller` is KusdtAccessManager's own, and unlike OpenZeppelin's built-in admin functions its mapping
 * also decides who may CALL it, so verify checks it is ADMIN's and nobody else's.
 */
export const MANAGER_ADMIN_ONLY_FUNCTIONS = ["revokeCanceller(address)"];

export const VAULT_FUNCTIONS: { signature: string; role: Exclude<RoleName, "ADMIN" | "CANCELLER" | "GUARDED"> }[] = [
  { signature: "setFees(uint16,uint256,uint256)", role: "GOVERNOR" },
  { signature: "setDepositSurge(uint16,uint256)", role: "GOVERNOR" },
  // Slow on purpose: a payout is cancelled because it should not be paid, and bringing one back must leave the
  // cancellers the same two days they have for any other change.
  { signature: "reinstateRelease(bytes32)", role: "GOVERNOR" },
  { signature: "reinstateRefund(uint64)", role: "GOVERNOR" },
  { signature: "setDepositLimits(uint256,uint256)", role: "GOVERNOR" },
  { signature: "setReleaseLimits(uint256,uint256)", role: "GOVERNOR" },
  { signature: "setSigners(address[5])", role: "GOVERNOR" },
  { signature: "setPayoutDelay(uint64)", role: "GOVERNOR" },
  { signature: "withdrawFees(address,uint256)", role: "GOVERNOR" },
  { signature: "transferOwnership(address)", role: "GOVERNOR" },
  { signature: "setGuardian(address)", role: "EMERGENCY" },
  { signature: "unpause()", role: "EMERGENCY" },
  { signature: "cancelRelease(bytes32)", role: "EMERGENCY" },
  { signature: "cancelRefund(uint64)", role: "EMERGENCY" },
  { signature: "pause()", role: "PAUSER" },
];
export const selectorOf = (signature: string) => id(signature).slice(0, 10);

/** The parts of AccessManager's ABI the scripts and the verifier use. */
export const ACCESS_MANAGER_ABI = [
  "function ADMIN_ROLE() view returns (uint64)",
  "function expiration() view returns (uint32)",
  "function minSetback() view returns (uint32)",
  "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
  "function getAccess(uint64 roleId, address account) view returns (uint48 since, uint32 currentDelay, uint32 pendingDelay, uint48 effect)",
  "function getRoleAdmin(uint64 roleId) view returns (uint64)",
  "function getRoleGuardian(uint64 roleId) view returns (uint64)",
  "function getRoleGrantDelay(uint64 roleId) view returns (uint32)",
  "function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)",
  "function getTargetAdminDelay(address target) view returns (uint32)",
  "function isTargetClosed(address target) view returns (bool)",
  "function getSchedule(bytes32 id) view returns (uint48)",
  "function hashOperation(address caller, address target, bytes data) view returns (bytes32)",
  "function labelRole(uint64 roleId, string label)",
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function revokeRole(uint64 roleId, address account)",
  "function revokeCanceller(address account)",
  "function CANCELLER_ROLE() view returns (uint64)",
  "function setRoleGuardian(uint64 roleId, uint64 guardian)",
  "function setTargetFunctionRole(address target, bytes4[] selectors, uint64 roleId)",
  "function schedule(address target, bytes data, uint48 when) returns (bytes32 operationId, uint32 nonce)",
  "function execute(address target, bytes data) payable returns (uint32)",
  "function cancel(address caller, address target, bytes data) returns (uint32)",
  "function multicall(bytes[] data) returns (bytes[] results)",
  "event OperationScheduled(bytes32 indexed operationId, uint32 indexed nonce, uint48 schedule, address caller, address target, bytes data)",
  "event OperationExecuted(bytes32 indexed operationId, uint32 indexed nonce)",
  "event OperationCanceled(bytes32 indexed operationId, uint32 indexed nonce)",
  "event RoleLabel(uint64 indexed roleId, string label)",
  "event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)",
  "event RoleRevoked(uint64 indexed roleId, address indexed account)",
  "event RoleAdminChanged(uint64 indexed roleId, uint64 indexed admin)",
  "event RoleGuardianChanged(uint64 indexed roleId, uint64 indexed guardian)",
  "event RoleGrantDelayChanged(uint64 indexed roleId, uint32 delay, uint48 since)",
  "event TargetClosed(address indexed target, bool closed)",
  "event TargetFunctionRoleUpdated(address indexed target, bytes4 selector, uint64 indexed roleId)",
  "event TargetAdminDelayUpdated(address indexed target, uint32 delay, uint48 since)",
];
export const accessManagerInterface = new Interface(ACCESS_MANAGER_ABI);

/** A vault owner set up through an AccessManager (the inputs' `{ safe, emergencyDelay?, cancellers }`). */
export interface OwnerConfig {
  safe: string;
  emergencyDelay: number;
  cancellers: string[];
}

function address(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${what}: ${JSON.stringify(v)} is not an address`);
  let a: string;
  try { a = getAddress(v); } // a bad mixed-case checksum is refused too
  catch { throw new Error(`${what}: ${v} is not a valid address (or its checksum is wrong)`); }
  if (a === ZeroAddress) throw new Error(`${what}: the zero address`);
  return a;
}

/** Checks and normalizes `{ safe, emergencyDelay?, cancellers }`; `what` names it in errors. */
export function checkOwnerConfig(raw: unknown, what: string): OwnerConfig {
  const r = raw as any;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${what}: expected { "safe": address, "emergencyDelay"?: seconds, "cancellers": [addresses] }`);
  for (const k of Object.keys(r)) if (!["safe", "emergencyDelay", "cancellers"].includes(k)) throw new Error(`${what}: unknown field "${k}"`);
  const safe = address(r.safe, `${what}.safe`);
  const emergencyDelay = r.emergencyDelay === undefined ? EMERGENCY_DELAY.default : r.emergencyDelay;
  if (typeof emergencyDelay !== "number" || !Number.isSafeInteger(emergencyDelay) || emergencyDelay < EMERGENCY_DELAY.min || emergencyDelay > EMERGENCY_DELAY.max) {
    throw new Error(`${what}.emergencyDelay: ${JSON.stringify(r.emergencyDelay)} seconds; it must be a whole number from ${EMERGENCY_DELAY.min} (1 h) to ${EMERGENCY_DELAY.max} (48 h)`);
  }
  if (!Array.isArray(r.cancellers) || r.cancellers.length < 1) throw new Error(`${what}.cancellers: list at least one canceller address`);
  const cancellers = r.cancellers.map((c: unknown, i: number) => address(c, `${what}.cancellers[${i}]`));
  if (new Set(cancellers).size !== cancellers.length) throw new Error(`${what}.cancellers: an address appears twice`);
  if (cancellers.includes(safe)) throw new Error(`${what}.cancellers: the Safe can't also be a canceller`);
  return { safe, emergencyDelay, cancellers };
}

/** Every role's expected configuration: members with their execution delays, admin, guardian, grant delay. */
export interface RoleSpec {
  name: RoleName;
  id: bigint;
  members: { account: string; delay: number }[];
  admin: bigint;
  guardian: bigint;
  grantDelay: number;
}
export function expectedRoles(cfg: OwnerConfig): RoleSpec[] {
  const safe = (delay: number) => [{ account: cfg.safe, delay }];
  return [
    // ADMIN's admin and guardian are ADMIN, and can't be changed (AccessManagerLockedRole).
    { name: "ADMIN", id: ROLES.ADMIN, members: safe(ADMIN_DELAY), admin: ROLES.ADMIN, guardian: ROLES.ADMIN, grantDelay: 0 },
    { name: "GOVERNOR", id: ROLES.GOVERNOR, members: safe(GOVERNOR_DELAY), admin: ROLES.ADMIN, guardian: ROLES.CANCELLER, grantDelay: 0 },
    { name: "EMERGENCY", id: ROLES.EMERGENCY, members: safe(cfg.emergencyDelay), admin: ROLES.ADMIN, guardian: ROLES.CANCELLER, grantDelay: 0 },
    { name: "PAUSER", id: ROLES.PAUSER, members: safe(PAUSER_DELAY), admin: ROLES.ADMIN, guardian: ROLES.ADMIN, grantDelay: 0 },
    { name: "CANCELLER", id: ROLES.CANCELLER, members: cfg.cancellers.map((account) => ({ account, delay: 0 })), admin: ROLES.ADMIN, guardian: ROLES.ADMIN, grantDelay: 0 },
    // Nobody holds it: it exists for its guardian, which may cancel the manager functions mapped to it.
    { name: "GUARDED", id: ROLES.GUARDED, members: [], admin: ROLES.ADMIN, guardian: ROLES.CANCELLER, grantDelay: 0 },
  ];
}

/** The vault's function → role table, with selectors. */
export function vaultFunctionRoles(): { signature: string; selector: string; role: RoleName; roleId: bigint }[] {
  return VAULT_FUNCTIONS.map((f) => ({ signature: f.signature, selector: selectorOf(f.signature), role: f.role, roleId: ROLES[f.role] }));
}

/** The manager's guarded functions, with selectors. */
export function managerGuardedFunctions(): { signature: string; selector: string }[] {
  return MANAGER_GUARDED_FUNCTIONS.map((signature) => ({ signature, selector: selectorOf(signature) }));
}

/** The manager's functions no canceller may cancel, with selectors. */
export function managerAdminOnlyFunctions(): { signature: string; selector: string }[] {
  return MANAGER_ADMIN_ONLY_FUNCTIONS.map((signature) => ({ signature, selector: selectorOf(signature) }));
}

/**
 * The calls the deployer makes, as the manager's first admin, in one `multicall`: labels, the
 * roles, the guardians, the vault's function roles, the manager's own guarded functions, and last
 * giving up its own ADMIN.
 */
export function setupCalls(cfg: OwnerConfig, vault: string, deployer: string, manager: string): string[] {
  const i = accessManagerInterface;
  const d = getAddress(deployer);
  if (d === cfg.safe || cfg.cancellers.includes(d)) throw new Error("the deployer can't be the Safe or a canceller: it gives up every role at the end");
  const calls: string[] = [];
  for (const name of ROLE_NAMES) if (name !== "ADMIN") calls.push(i.encodeFunctionData("labelRole", [ROLES[name], name]));
  for (const r of expectedRoles(cfg)) {
    for (const m of r.members) calls.push(i.encodeFunctionData("grantRole", [r.id, m.account, m.delay]));
    if (r.id !== ROLES.ADMIN && r.guardian !== ROLES.ADMIN) calls.push(i.encodeFunctionData("setRoleGuardian", [r.id, r.guardian]));
  }
  const byRole = new Map<bigint, string[]>();
  for (const f of vaultFunctionRoles()) byRole.set(f.roleId, [...(byRole.get(f.roleId) ?? []), f.selector]);
  for (const [roleId, selectors] of byRole) calls.push(i.encodeFunctionData("setTargetFunctionRole", [getAddress(vault), selectors, roleId]));
  if (getAddress(manager) === getAddress(vault)) throw new Error("the manager and the vault are the same address");
  calls.push(i.encodeFunctionData("setTargetFunctionRole", [getAddress(manager), managerGuardedFunctions().map((f) => f.selector), ROLES.GUARDED]));
  calls.push(i.encodeFunctionData("revokeRole", [ROLES.ADMIN, d]));
  return calls;
}

/** A readable summary of the configuration, for the plan and the logs. */
export function describeOwner(cfg: OwnerConfig): string[] {
  const fns = (role: RoleName) => VAULT_FUNCTIONS.filter((f) => f.role === role).map((f) => f.signature.split("(")[0]).join(", ");
  const h = (s: number) => (s % HOUR === 0 ? `${s / HOUR} h` : `${s} s`);
  return [
    `ADMIN (0): the Safe ${cfg.safe}, delay ${h(ADMIN_DELAY)}: the manager's roles, delays and targets`,
    `GOVERNOR (1): the Safe, delay ${h(GOVERNOR_DELAY)}: ${fns("GOVERNOR")}`,
    `EMERGENCY (2): the Safe, delay ${h(cfg.emergencyDelay)}: ${fns("EMERGENCY")}`,
    `PAUSER (3): the Safe, no delay: ${fns("PAUSER")}`,
    `CANCELLER (4): ${cfg.cancellers.join(", ")}: cancels scheduled GOVERNOR and EMERGENCY calls, and the manager's own power-adding calls and revocations (not a canceller's removal, revokeCanceller)`,
    `GUARDED (5): nobody; the manager's ${MANAGER_GUARDED_FUNCTIONS.map((f) => f.split("(")[0]).join(", ")} are mapped to it, so the cancellers can cancel them`,
  ];
}
