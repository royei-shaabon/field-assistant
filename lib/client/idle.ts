// A call nobody is on. When the technician has neither spoken nor touched the screen for a
// minute, the assistant asks whether they are still there; with no sign of them for another
// quarter of a minute it says goodbye, and the call ends. The time the assistant itself is
// speaking never counts as silence, and any word or touch brings the call back to normal.
export const IDLE_ASK_MS = 60_000;
export const IDLE_END_MS = 15_000;
// How long the goodbye may take before the call is closed anyway.
export const IDLE_BYE_MS = 12_000;

export type IdleStep = "ask" | "bye" | "end" | null;

export class IdleWatch {
  private phase: "active" | "asked" | "leaving" = "active";
  // The moment silence began: the technician's last sign, or the end of the assistant's last words.
  private since: number;
  private speaking = false;
  // In "leaving": the assistant has begun the goodbye, so its end is the end of the call.
  private spoke = false;

  constructor(now: number, private askMs = IDLE_ASK_MS, private endMs = IDLE_END_MS, private byeMs = IDLE_BYE_MS) {
    this.since = now;
  }

  // The technician spoke, or touched the screen.
  activity(now: number): void {
    this.phase = "active";
    this.since = now;
  }

  // The assistant began or finished speaking.
  agent(speaking: boolean, now: number): void {
    if (speaking && this.phase === "leaving") this.spoke = true;
    if (this.speaking && !speaking) this.since = now;
    this.speaking = speaking;
  }

  // Called about once a second. Says what to do now, each thing once.
  tick(now: number): IdleStep {
    const quiet = now - this.since;
    if (this.phase === "leaving") {
      // The goodbye was said to its end, or it never came.
      return (this.spoke && !this.speaking) || quiet >= this.byeMs ? ((this.phase = "active"), (this.since = now), "end") : null;
    }
    if (this.speaking) return null;
    if (this.phase === "active" && quiet >= this.askMs) {
      this.phase = "asked";
      this.since = now;
      return "ask";
    }
    if (this.phase === "asked" && quiet >= this.endMs) {
      this.phase = "leaving";
      this.since = now;
      this.spoke = false;
      return "bye";
    }
    return null;
  }
}
