/* @vitest-environment jsdom */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../ui/src/test-helpers/mount-solid.js";
import { InviteForm } from "./invite-form.js";
import { createPeopleMotion } from "./people-motion.js";
import type { Role, RoleSandboxReadiness } from "./types.js";

type PickerOptions = Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1];

function hostComponents(onPicker: (options: PickerOptions) => void) {
  const unused = () => {
    throw new Error("unused host component");
  };
  const components: ControlUiHost["components"] = {
    resolveAppearanceColor: unused,
    mountAgentAvatar: unused,
    mountAppearancePicker: unused,
    mountAppearanceGlyph: unused,
    mountDialog: unused,
    mountAgentPicker: unused,
    mountSessionSummary: unused,
    mountDashboard: unused,
    mountSelectPicker: (_container, initial) => {
      onPicker(initial);
      return { update: onPicker, dispose() {} };
    },
  };
  return components;
}

const guest = (sandbox?: RoleSandboxReadiness): Role => ({
  name: "guest",
  defined: true,
  sessions: "view",
  admin: false,
  requiresSandbox: true,
  ...(sandbox ? { sandbox } : {}),
});
const operator: Role = {
  name: "operator",
  defined: true,
  sessions: "write",
  admin: false,
  requiresSandbox: false,
};

it("blocks inviting to a role whose sandbox cannot start and names the next step", () => {
  let picker!: PickerOptions;
  const onCreate = vi.fn();
  let setReadiness!: (value: RoleSandboxReadiness | undefined) => void;
  const { container } = mountSolid(() => {
    const [readiness, update] = createSignal<RoleSandboxReadiness | undefined>({
      ready: false,
      reason: "image_missing",
      backend: "docker",
      image: "openclaw-sandbox:trixie-slim",
      doctorBuilds: true,
    });
    setReadiness = update;
    return (
      <InviteForm
        motion={createPeopleMotion()}
        components={hostComponents((options) => (picker = options))}
        roles={[operator, guest(readiness())]}
        disabled={false}
        locale="en-US"
        onCreate={onCreate}
      />
    );
  });
  flush();
  const notice = () => container.querySelector(".ocid-access__role-notice[role=status]");
  expect(notice()?.textContent).toContain(
    "The guest role requires a sandbox, but the sandbox image openclaw-sandbox:trixie-slim is missing. Run openclaw doctor --fix on this claw",
  );
  expect(notice()?.querySelector("a")?.getAttribute("href")).toBe(
    "https://docs.openclaw.ai/gateway/sandboxing",
  );
  expect(picker.options.find((option) => option.value === "guest")).toMatchObject({
    disabled: true,
    description: expect.stringContaining("not set up on this claw"),
  });
  expect(picker.value).toBe("operator");
  picker.onSelect("guest");
  flush();
  expect(picker.value).toBe("operator");

  setReadiness({ ready: false, reason: "engine_unavailable", backend: "podman" });
  flush();
  expect(notice()?.textContent).toContain("Podman is not reachable on this claw. Start Podman");

  setReadiness({ ready: true });
  flush();
  expect(notice()).toBeNull();
  expect(picker.options.find((option) => option.value === "guest")?.disabled).toBe(false);
  picker.onSelect("guest");
  flush();
  expect(picker.value).toBe("guest");

  // A chosen role that stops being grantable stays chosen and blocks submission, never
  // silently becoming another role.
  const submit = () => container.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  email.value = "guest@example.test";
  email.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(submit().disabled).toBe(false);
  setReadiness({ ready: false, reason: "engine_unavailable", backend: "docker" });
  flush();
  expect(picker.value).toBe("guest");
  expect(submit().disabled).toBe(true);
  setReadiness({ ready: true });
  flush();

  // An unverifiable backend, or People data without readiness, does not block the role.
  setReadiness({ ready: null, backend: "ssh" });
  flush();
  expect(notice()).toBeNull();
  setReadiness(undefined);
  flush();
  expect(notice()).toBeNull();
  expect(picker.value).toBe("guest");
});

it("disables invite creation when every member role is waiting on its sandbox", () => {
  let picker!: PickerOptions;
  const { container } = mountSolid(() => (
    <InviteForm
      motion={createPeopleMotion()}
      components={hostComponents((options) => (picker = options))}
      roles={[
        guest({
          ready: false,
          reason: "image_missing",
          backend: "docker",
          image: "registry.example.test/sandbox:1",
          doctorBuilds: false,
        }),
      ]}
      disabled={false}
      locale="en-US"
      onCreate={vi.fn()}
    />
  ));
  flush();
  expect(picker.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  expect(container.textContent).toContain(
    "registry.example.test/sandbox:1 is missing. Build or pull it on this claw",
  );
});
