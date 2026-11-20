/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { roleText } from "./i18n.js";
import { roleName } from "./people-format.js";
import { unreadySandboxRoles } from "./people-roles.js";
import type { Role } from "./types.js";

function notReadyText(role: Role, locale: string): string {
  const readiness = role.defined ? role.sandbox : undefined;
  if (readiness?.ready !== false) {
    return "";
  }
  const name = roleName(role.name);
  if (readiness.reason === "engine_unavailable") {
    return roleText(locale, "sandboxEngineUnavailable", {
      role: name,
      engine: readiness.backend === "podman" ? "Podman" : "Docker",
    });
  }
  return roleText(
    locale,
    readiness.doctorBuilds ? "sandboxImageMissing" : "sandboxCustomImageMissing",
    {
      role: name,
      image: readiness.image,
    },
  );
}

/** Explains why roles that require a sandbox cannot be granted yet, and the next step. */
export function SandboxRoleNotice(props: { roles: Role[]; locale: string }) {
  const unready = () => unreadySandboxRoles(props.roles);
  return (
    <Show when={unready().length > 0}>
      <div class="ocid-access__role-notice" role="status">
        <For each={unready()} keyed={(role) => role.name}>
          {(role) => <p>{notReadyText(role(), props.locale)}</p>}
        </For>
        <a href="https://docs.openclaw.ai/gateway/sandboxing" target="_blank" rel="noreferrer">
          {roleText(props.locale, "sandboxSetup")}
        </a>
      </div>
    </Show>
  );
}
