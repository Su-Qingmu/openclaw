import {
  parseStatement,
  type AuthorityEvent,
  type AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { AuthorityRefusal } from "./authority-result.js";

class UndefinedMemberRoleError extends Error {
  constructor(role: string) {
    super(`The role ${role} is not defined on this claw. Choose another role on the Access page.`);
  }
}

export function refuseUndefinedMemberRole(error: unknown): AuthorityRefusal {
  if (error instanceof UndefinedMemberRoleError) {
    return { ok: false, code: "role_undefined", detail: error.message };
  }
  throw error;
}

/** The role a MembershipChange moves an existing member to, if it is a role change. */
function changedMemberRole(input: unknown): string | undefined {
  const change = parseStatement(input, "MembershipChange");
  return change.ok && change.statement.body.target.op === "set_role"
    ? change.statement.body.target.role
    : undefined;
}

/** Validate the target role once when the queued owner-signed change starts. */
export function assertMemberRoleDefined(input: unknown): void {
  const role = changedMemberRole(input);
  if (
    role !== undefined &&
    !Object.hasOwn(getRuntimeConfigSnapshot()?.gateway?.roles?.definitions ?? {}, role)
  ) {
    throw new UndefinedMemberRoleError(role);
  }
}

/** The role an InviteCap grants when redeemed. */
function invitedMemberRole(cap: unknown): string | undefined {
  const parsed = parseStatement(cap, "InviteCap");
  return parsed.ok ? parsed.statement.body.role : undefined;
}

/**
 * Refuses granting a role that requires a sandbox while that sandbox cannot start, so the
 * owner sets up sandboxing before inviting or moving anyone to the role.
 */
async function refuseUnreadySandboxGrant(grant: unknown): Promise<AuthorityRefusal | undefined> {
  const role = changedMemberRole(grant) ?? invitedMemberRole(grant);
  const cfg = getRuntimeConfigSnapshot() ?? undefined;
  const definitions = cfg?.gateway?.roles?.definitions ?? {};
  const definition =
    role !== undefined && Object.hasOwn(definitions, role) ? definitions[role] : undefined;
  if (role === undefined || definition?.sandbox !== "required") {
    return undefined;
  }
  const { createRoleSandboxReadinessCheck, sandboxUnavailableDetail } =
    await import("./sandbox-availability.js");
  const readiness = await createRoleSandboxReadinessCheck(cfg)(definition.agents);
  return readiness.ready === false
    ? { ok: false, code: "sandbox_unavailable", detail: sandboxUnavailableDetail(role, readiness) }
    : undefined;
}

/**
 * Queues an owner-signed MembershipChange or InviteCap unless it grants a role whose sandbox
 * cannot start. The engine probe runs once, before the write queue, so it never blocks other
 * writes; the statement's signature is verified on the queue as before.
 */
export async function queueSandboxGrant<T>(
  grant: unknown,
  queue: (work: () => Promise<T>) => Promise<T>,
  work: () => Promise<T>,
): Promise<T | AuthorityRefusal> {
  return (await refuseUnreadySandboxGrant(grant)) ?? (await queue(work));
}

// A member whose role changed reconnects, so their Gateway connections pick up the
// new role's scope ceiling instead of keeping the one granted at connect.
export function roleChangeDisconnects(
  before: AuthorityState,
  after: AuthorityState,
): AuthorityEvent[] {
  const peerKeys = Object.entries(after.members).flatMap(([accountId, member]) => {
    const previous = before.members[accountId];
    return previous && previous.role !== member.role ? member.peer_keys : [];
  });
  return peerKeys.length > 0 ? [{ type: "disconnect", peer_keys: peerKeys }] : [];
}
