import { memo, type PointerEventHandler } from "react";
import { MicIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { VoiceInputState } from "~/voice/useVoiceInput";
import { Spinner } from "../ui/spinner";

interface ComposerVoiceButtonProps {
  state: VoiceInputState;
  disabled: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onToggle: () => void;
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

const LABEL_BY_STATE: Record<VoiceInputState, string> = {
  idle: "Start dictation",
  recording: "Stop dictation",
  transcribing: "Transcribing",
};

/**
 * Microphone toggle for the composer footer. Recording is signalled with a
 * static filled state rather than a pulse: the composer is on screen all day and
 * a looping animation costs a repaint every frame.
 */
export const ComposerVoiceButton = memo(function ComposerVoiceButton({
  state,
  disabled,
  preserveComposerFocusOnPointerDown = false,
  onToggle,
}: ComposerVoiceButtonProps) {
  const isRecording = state === "recording";
  const isTranscribing = state === "transcribing";

  return (
    <button
      type="button"
      data-chat-composer-voice-state={state}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-30 sm:h-8 sm:w-8",
        isRecording
          ? "bg-destructive/90 text-white hover:bg-destructive"
          : "text-secondary-label hover:bg-accent/60 hover:text-foreground",
      )}
      {...(preserveComposerFocusOnPointerDown ? { onPointerDown: preventPointerFocus } : {})}
      disabled={disabled || isTranscribing}
      aria-label={LABEL_BY_STATE[state]}
      aria-pressed={isRecording}
      onClick={onToggle}
    >
      {isTranscribing ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : isRecording ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      ) : (
        <MicIcon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
});
