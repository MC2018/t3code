/**
 * Gates the composer microphone on the environment actually having a
 * speech-to-text backend, and on the browser being able to record at all.
 *
 * The probe result is cached for the life of the page: whether the host
 * configured a backend is a property of how the server was started, so
 * re-asking on every composer mount would be pure overhead.
 */
import { useEffect, useState } from "react";

import { fetchVoiceHealth } from "./voiceApi";
import { isVoiceCaptureSupported } from "./useVoiceInput";

let cachedProbe: Promise<boolean> | null = null;

/**
 * Only a positive answer is cached. A probe that runs before the session is
 * established answers "not configured", and caching that would hide the
 * microphone for the rest of the page's life.
 */
function probeVoiceAvailability(): Promise<boolean> {
  cachedProbe ??= fetchVoiceHealth().then((health) => {
    if (!health.configured) cachedProbe = null;
    return health.configured;
  });
  return cachedProbe;
}

export function __resetVoiceAvailabilityForTests(): void {
  cachedProbe = null;
}

export function useVoiceAvailability(): boolean {
  const [isAvailable, setIsAvailable] = useState(false);

  useEffect(() => {
    if (!isVoiceCaptureSupported()) return;

    let active = true;
    void probeVoiceAvailability().then((configured) => {
      if (active) setIsAvailable(configured);
    });
    return () => {
      active = false;
    };
  }, []);

  return isAvailable;
}
