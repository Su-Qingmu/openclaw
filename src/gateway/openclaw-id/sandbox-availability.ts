import { listAgentIds } from "../../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import {
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
} from "../../agents/sandbox/constants.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
} from "../../agents/sandbox/container-engine.js";
import { inspectContainerImage } from "../../agents/sandbox/container-image.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Whether sessions of a role that requires a sandbox can start one now. `null` means this
 * Gateway cannot check the selected backend (non-container plugins), so it does not block.
 */
export type RoleSandboxReadiness =
  | { ready: true }
  | { ready: null; backend: string }
  | { ready: false; reason: "engine_unavailable"; backend: string }
  | {
      ready: false;
      reason: "image_missing";
      backend: string;
      image: string;
      /** `openclaw doctor --fix` builds this image; otherwise the owner builds or pulls it. */
      doctorBuilds: boolean;
    };

type RoleAgents = "*" | readonly string[];

/**
 * Checks every agent the role can use: its sandbox backend must be reachable and its image
 * present. Probes run fresh and are shared only within one returned checker.
 */
export function createRoleSandboxReadinessCheck(cfg: OpenClawConfig | undefined) {
  const engines = new Map<string, Promise<SandboxContainerEngine | undefined>>();
  const images = new Map<string, Promise<"exists" | "missing" | "unavailable">>();
  const engineFor = (backend: "docker" | "podman") => {
    let engine = engines.get(backend);
    if (!engine) {
      engine = (async () => {
        try {
          let selected = DOCKER_SANDBOX_ENGINE;
          if (backend === "podman") {
            const { bindPodmanSandboxEngine, resolvePodmanSandboxRuntimeInfo } =
              await import("../../agents/sandbox/podman-runtime.js");
            selected = bindPodmanSandboxEngine((await resolvePodmanSandboxRuntimeInfo()).target);
          }
          // Probe the selected target afresh; an installed client or cached target is not liveness.
          await execContainer(selected, ["info"], { signal: AbortSignal.timeout(30_000) });
          return selected;
        } catch {
          return undefined;
        }
      })();
      engines.set(backend, engine);
    }
    return engine;
  };
  const imageState = (engine: SandboxContainerEngine, image: string) => {
    const key = `${engine.id}\0${image}`;
    let state = images.get(key);
    if (!state) {
      state = inspectContainerImage(engine, image).catch(() => "unavailable" as const);
      images.set(key, state);
    }
    return state;
  };

  return async (agents: RoleAgents): Promise<RoleSandboxReadiness> => {
    const agentIds = agents === "*" ? listAgentIds(cfg ?? {}) : agents;
    let unverified: string | undefined;
    for (const agentId of agentIds) {
      const sandbox = resolveSandboxConfigForAgent(cfg, agentId);
      const backend = sandbox.backend.toLowerCase();
      if (backend !== "docker" && backend !== "podman") {
        unverified ??= backend;
        continue;
      }
      const engine = await engineFor(backend);
      const image = sandbox.docker.image;
      const state = engine ? await imageState(engine, image) : "unavailable";
      if (state === "unavailable") {
        return { ready: false, reason: "engine_unavailable", backend };
      }
      if (state === "missing") {
        return {
          ready: false,
          reason: "image_missing",
          backend,
          image,
          doctorBuilds:
            backend === "docker" &&
            (image === DEFAULT_SANDBOX_IMAGE || image === DEFAULT_SANDBOX_COMMON_IMAGE),
        };
      }
    }
    return unverified ? { ready: null, backend: unverified } : { ready: true };
  };
}

/** Why a role whose sandbox cannot start is not granted, and the next step. */
export function sandboxUnavailableDetail(
  role: string,
  readiness: Extract<RoleSandboxReadiness, { ready: false }>,
): string {
  const engine = readiness.backend === "podman" ? "Podman" : "Docker";
  return readiness.reason === "engine_unavailable"
    ? `The ${role} role requires a sandbox, but ${engine} is not reachable on this claw. Start ${engine}, then try again.`
    : `The ${role} role requires a sandbox, but the sandbox image ${readiness.image} is missing. ${
        readiness.doctorBuilds
          ? "Run openclaw doctor --fix on this claw to build it"
          : "Build or pull it on this claw"
      }, then try again.`;
}
