type RecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};

export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onnomatch: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export function captureSpeech(
  recognizer: Recognition,
  language: string,
  callbacks: {
    preview: (text: string) => void;
    completed: (result: { text: string; usedInterim: boolean; error?: string }) => void;
  },
) {
  let finalText = '';
  let interimText = '';
  let ended = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  function cleanup(abort: boolean) {
    ended = true;
    clearTimeout(stopTimer);
    recognizer.onresult = null;
    recognizer.onerror = recognizer.onnomatch = recognizer.onend = null;
    if (abort) {
      try {
        recognizer.abort();
      } catch {
        // Some browsers have already released the microphone after reporting an error.
      }
    }
  }

  function finish(error?: string, abort = false) {
    if (ended) return;
    cleanup(abort);
    callbacks.completed({
      text: [finalText, interimText].filter(Boolean).join(' '),
      usedInterim: !!interimText,
      error,
    });
  }

  recognizer.lang = language;
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.onresult = ({ results }) => {
    if (ended) return;
    const finalized: string[] = [];
    const pending: string[] = [];
    for (const result of Array.from(results)) {
      const transcript = result[0]?.transcript.trim();
      if (transcript) (result.isFinal ? finalized : pending).push(transcript);
    }
    const nextFinal = finalized.join(' ');
    if (nextFinal !== finalText || pending.length) interimText = pending.join(' ');
    finalText = nextFinal;
    if (stopTimer !== undefined && finalText && !interimText) {
      finish();
      return;
    }
    callbacks.preview([finalText, interimText].filter(Boolean).join(' '));
  };
  recognizer.onerror = ({ error }) => finish(error, true);
  recognizer.onnomatch = () => finish('no-speech', true);
  recognizer.onend = () => finish();

  return {
    start() {
      try {
        recognizer.start();
      } catch {
        finish('start-failed', true);
      }
    },
    stop() {
      if (ended || stopTimer !== undefined) return;
      stopTimer = setTimeout(() => finish('timeout', true), 5_000);
      try {
        recognizer.stop();
      } catch {
        finish('stop-failed', true);
      }
    },
    cancel() {
      if (!ended) cleanup(true);
    },
  };
}
