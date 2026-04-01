let audioContext = null;

async function playResultSound() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const now = audioContext.currentTime;
  const notes = [
    { frequency: 880, start: now, duration: 0.08 },
    { frequency: 1174.66, start: now + 0.11, duration: 0.1 }
  ];

  for (const note of notes) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, note.start);

    gainNode.gain.setValueAtTime(0.0001, note.start);
    gainNode.gain.exponentialRampToValueAtTime(0.12, note.start + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, note.start + note.duration);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(note.start);
    oscillator.stop(note.start + note.duration + 0.02);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "play-result-sound") {
    return false;
  }

  void playResultSound()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
