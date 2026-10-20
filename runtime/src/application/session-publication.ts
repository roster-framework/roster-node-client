import type { SessionJournal } from "./session-journal.js";
import type { SessionRecord } from "../domain/session-delivery.js";

// The pending queue is not published or acknowledged storage. Only committed
// records are delivered. A crash may lose pending records, never emitted ones.
export class SessionPublication<Frame> {
  private pending: {record: SessionRecord; frame: Frame}[] = [];
  private scheduled?: NodeJS.Immediate;
  private failed = false;
  private failure: unknown;
  constructor(private journal: SessionJournal | undefined, private execution: string,
    private deliver: (frame: Frame) => void, private onFailure: (error: unknown) => void) {}

  publish(record: SessionRecord, frame: Frame) {
    if(this.failed) throw this.failure;
    if(!this.journal?.appendBatch) {
      try { this.journal?.append(this.execution,record); }
      catch(error) { this.fail(error); throw error; }
      this.deliver(frame);
      return;
    }
    this.pending.push({record:{...record},frame});
    if(this.pending.length===64) this.flush();
    else if(!this.scheduled) this.scheduled=setImmediate(()=>{
      this.scheduled=undefined;
      try { this.flush(); } catch { /* fail() already interrupts the execution. */ }
    });
  }

  flush() {
    if(this.scheduled) { clearImmediate(this.scheduled); this.scheduled=undefined; }
    if(this.failed) throw this.failure;
    const pending=this.pending.splice(0);
    if(!pending.length) return;
    try { this.journal!.appendBatch!(this.execution,pending.map(v=>v.record)); }
    catch(error) { this.fail(error); throw error; }
    for(const value of pending) this.deliver(value.frame);
  }

  private fail(error: unknown) {
    this.failed=true;this.failure=error;
    this.onFailure(error);
  }
}
