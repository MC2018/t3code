/**
 * Gates the composer microphone on the connected environment actually having a
 * speech-to-text backend.
 *
 * Whether a backend exists is a property of how that server was started, so the
 * probe result is cached per environment for the life of the process. Only a
 * positive answer is cached: a probe that runs before the connection is ready
 * answers "not configured", and caching that would hide the microphone until
 * the app restarts.
 */
import { useEffect, useState } from "react";

import { fetchVoiceHealth, type VoiceEnvironmentConnection } from "./voiceApi";

const probesByEnvironment = new Map<string, Promise<boolean>>();

export function __resetVoiceAvailabilityForTests(): void {
  probesByEnvironment.clear();
}

function probeVoiceAvailability(
  environmentId: string,
  connection: VoiceEnvironmentConnection,
): Promise<boolean> {
  const existing = probesByEnvironment.get(environmentId);
  if (existing !== undefined) return existing;

  const probe = fetchVoiceHealth(connection).then((health) => {
    if (!health.configured) probesByEnvironment.delete(environmentId);
    return health.configured;
  });
  probesByEnvironment.set(environmentId, probe);
  return probe;
}

export function useVoiceAvailability(input: {
  readonly environmentId: string | null;
  readonly connection: VoiceEnvironmentConnection | null;
}): boolean {
  const [isAvailable, setIsAvailable] = useState(false);
  const { environmentId, connection } = input;
  const httpBaseUrl = connection?.httpBaseUrl ?? null;

  useEffect(() => {
    if (environmentId === null || connection === null || httpBaseUrl === null) {
      setIsAvailable(false);
      return;
    }

    let active = true;
    void probeVoiceAvailability(environmentId, connection).then((configured) => {
      if (active) setIsAvailable(configured);
    });
    return () => {
      active = false;
    };
    // Re-probe when the environment or its address changes, not on every token refresh.
  }, [environmentId, httpBaseUrl]);

  return isAvailable;
}
