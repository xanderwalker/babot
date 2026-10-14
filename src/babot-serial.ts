import {
  BABOT_PROTOCOL,
  formatArmCommand,
  formatPingCommand,
  formatPoseCommand,
  formatStopCommand,
  isApprovedControllerOrigin,
} from "./protocol.mjs";

type Port = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};
type Serial = {
  getPorts(): Promise<Port[]>;
  requestPort(options: { filters: { usbVendorId: number; usbProductId: number }[] }): Promise<Port>;
};
export type BabotPose = { roll: number; pitch: number; sampledAt: number };
export type StopResult = { acknowledged: boolean; offConfirmed: boolean };
export type BabotStatus = {
  phase: "disconnected" | "connecting" | "ready" | "arming" | "following" | "stopping" | "stopped" | "fault";
  lastLine: string;
  offConfirmed: boolean;
};
type StatusListener = (message: string, connected: boolean, active: boolean, detail: BabotStatus) => void;
type Pending = { id: number; verb: string; resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const CONTROLLER_FILTERS = [
  { usbVendorId: 0x2341, usbProductId: 0x8036 },
  { usbVendorId: 0x2a03, usbProductId: 0x8036 },
];

/** One acknowledged command at a time. No stale-pose backlog or automatic re-arm. */
export class BabotSerial {
  private port: Port | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readTask: Promise<void> | null = null;
  private pending: Pending | null = null;
  private inFlight: Promise<string> | null = null;
  private opening: Promise<boolean> | null = null;
  private stopping: Promise<StopResult> | null = null;
  private sequence = 0;
  private generation = 0;
  private connectionGeneration = 0;
  private closing = false;
  private verified = false;
  private following = false;
  private active = false;
  private mayBeArmed = false;
  private returning = false;
  private offCount = 0;
  private lastLine = "";
  private offConfirmed = false;
  private offWaiter: (() => void) | null = null;

  constructor(private onStatus: StatusListener) {}

  private status(message: string, phase: BabotStatus["phase"]) {
    this.onStatus(message, this.verified && Boolean(this.port), this.active,
      { phase, lastLine: this.lastLine, offConfirmed: this.offConfirmed });
  }

  private rejectPending(message: string) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }

  private fault(message: string, firmwareDisarmed = false) {
    this.generation++;
    this.active = false;
    this.following = false;
    this.verified = false;
    if (firmwareDisarmed) {
      this.mayBeArmed = false;
      this.returning = true;
      this.offConfirmed = false;
    }
    this.rejectPending(message);
    this.status(message, "fault");
    if (!firmwareDisarmed && this.mayBeArmed && !this.stopping) {
      void this.stop(message);
    }
  }

  private handleLine(line: string) {
    if (!line) return;
    this.lastLine = line;
    const response = /^(ACK|NACK) (\d+) (.+)$/.exec(line);
    if (response) {
      const pending = this.pending;
      if (pending?.id === Number(response[2])) {
        this.pending = null;
        clearTimeout(pending.timer);
        if (response[1] === "NACK" || response[3].split(" ")[0] !== pending.verb) {
          pending.reject(new Error(line));
        } else {
          pending.resolve(line);
        }
      } else if (response[1] === "NACK") {
        this.fault(line);
      }
      return;
    }
    if (/^EVENT (WATCHDOG|BUTTON_EXIT|IK_FAULT)$/.test(line)) {
      this.fault(`${line} · waiting for firmware OFF`, true);
    } else if (line === "EVENT OFF") {
      this.offCount++;
      this.offConfirmed = true;
      this.mayBeArmed = false;
      this.returning = false;
      this.active = false;
      this.offWaiter?.();
      if (this.following) {
        this.generation++;
        this.following = false;
        this.verified = false;
        this.status("Firmware reports OFF · motion stopped", "fault");
      } else if (!this.stopping) {
        this.status("Firmware reports OFF · level return complete", this.verified ? "stopped" : "fault");
      }
    } else if (line.startsWith("READY ") && this.mayBeArmed) {
      this.mayBeArmed = false;
      this.fault("Firmware restarted · reconnect before replay");
    }
  }

  private async read() {
    const reader = this.reader!;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.closing) {
        const { value, done } = await reader.read();
        if (done) {
          if (!this.closing) this.fault("USB disconnected · motion stopped");
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 8192) throw new Error("Invalid USB response");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          this.handleLine(buffer.slice(0, newline).trim());
          buffer = buffer.slice(newline + 1);
        }
      }
    } catch (error) {
      if (!this.closing) this.fault(error instanceof Error ? error.message : "USB read failed");
    }
  }

  private send(verb: "PING" | "ARM" | "POSE" | "STOP", pose?: BabotPose, timeout: number = BABOT_PROTOCOL.responseTimeoutMs): Promise<string> {
    if (this.pending || this.inFlight) return Promise.reject(new Error("A BaBot command is already outstanding"));
    if (!this.writer || ++this.sequence >= 0xffffffff) return Promise.reject(new Error("Reconnect BaBot"));
    const id = this.sequence;
    let wire: string;
    try {
      wire = verb === "PING" ? formatPingCommand(id) : verb === "ARM" ? formatArmCommand(id)
        : verb === "STOP" ? formatStopCommand(id) : formatPoseCommand(id, pose);
    } catch (error) { return Promise.reject(error); }
    const writer = this.writer;
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) this.pending = null;
        reject(new Error(`${verb} acknowledgement timed out`));
      }, timeout);
      this.pending = { id, verb, resolve, reject, timer };
      void writer.write(new TextEncoder().encode(wire)).catch(() => {
        if (this.pending?.id === id) this.rejectPending("USB write failed");
      });
    });
    const tracked = reply.finally(() => { if (this.inFlight === tracked) this.inFlight = null; });
    this.inFlight = tracked;
    return tracked;
  }

  connect(): Promise<boolean> {
    return this.beginConnection(true);
  }

  /** Reuse browser permission without opening a picker or starting motion. */
  reconnect(): Promise<boolean> {
    return this.beginConnection(false);
  }

  private beginConnection(allowChooser: boolean): Promise<boolean> {
    if (this.verified) return Promise.resolve(true);
    if (this.opening) return this.opening;
    const generation = this.connectionGeneration;
    this.opening = this.open(generation, allowChooser).finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(generation: number, allowChooser: boolean) {
    if (!isApprovedControllerOrigin({ isSecureContext: window.isSecureContext, isTopLevel: window.top === window.self })) {
      throw new Error("Open the player directly in a secure browser tab (HTTPS or localhost) to connect BaBot");
    }
    const api = (navigator as Navigator & { serial?: Serial }).serial;
    if (!api) throw new Error("USB control requires desktop Chrome with Web Serial");
    this.status("Checking remembered BaBot permission", "connecting");
    const granted = await api.getPorts();
    if (generation !== this.connectionGeneration) return false;
    const eligible = granted.filter((port) => {
      const info = port.getInfo();
      return CONTROLLER_FILTERS.some((filter) => info.usbVendorId === filter.usbVendorId && info.usbProductId === filter.usbProductId);
    });
    let selected: Port;
    if (eligible.length === 1) {
      selected = eligible[0];
      this.status("Reconnecting remembered BaBot", "connecting");
    } else {
      if (!allowChooser) {
        this.status(eligible.length > 1 ? "Multiple remembered controllers · select Connect to choose BaBot" : "Select Connect to grant BaBot USB access once", "disconnected");
        return false;
      }
      this.status("Choose BaBot / Arduino Leonardo", "connecting");
      selected = await api.requestPort({ filters: CONTROLLER_FILTERS });
    }
    if (generation !== this.connectionGeneration) return false;
    if (this.port) { await this.stop(); await this.close(); }
    if (generation !== this.connectionGeneration) return false;
    this.closing = false;
    this.port = selected;
    this.sequence = 0;
    this.offConfirmed = false;
    try {
      await selected.open({ baudRate: BABOT_PROTOCOL.baudRate });
      if (generation !== this.connectionGeneration) { await this.close(); return false; }
      if (!selected.readable || !selected.writable) throw new Error("USB data streams unavailable");
      this.reader = selected.readable.getReader();
      this.writer = selected.writable.getWriter();
      this.readTask = this.read();
      const line = await this.send("PING", undefined, 1500);
      if (!/^ACK \d+ PING BABOT_MOTION 1$/.test(line)) throw new Error("BaBot Motion firmware v1 was not identified");
      if (generation !== this.connectionGeneration) { await this.close(); return false; }
      this.verified = true;
      this.status("BaBot firmware verified · ready for replay", "ready");
      return true;
    } catch (error) {
      await this.close();
      this.status(error instanceof Error ? error.message : "USB connection failed", "fault");
      throw error;
    }
  }

  private usablePose(pose: BabotPose | null) {
    if (!pose || !Number.isFinite(pose.roll) || !Number.isFinite(pose.pitch) || !Number.isFinite(pose.sampledAt)) return false;
    const age = performance.now() - pose.sampledAt;
    return age >= -20 && age <= BABOT_PROTOCOL.staleSampleMs;
  }

  async start(getPose: () => BabotPose | null): Promise<void> {
    const beforeStop = this.generation;
    if (this.stopping) await this.stopping;
    if (beforeStop !== this.generation) return;
    if (!this.verified || !this.writer) throw new Error("Connect and verify BaBot before starting");
    if (this.following || this.active) throw new Error("BaBot is already following");
    if (this.returning) throw new Error("Wait for firmware EVENT OFF before replay");
    if (!this.usablePose(getPose())) throw new Error("No fresh synchronized video pose; play the video first");
    const generation = ++this.generation;
    this.following = true;
    try {
      const identity = await this.send("PING", undefined, 1500);
      if (!/^ACK \d+ PING BABOT_MOTION 1$/.test(identity)) throw new Error("BaBot firmware verification failed");
      if (generation !== this.generation) return;
      if (!this.usablePose(getPose())) { await this.stop("Video pose unavailable · motion stopped"); return; }
      this.status("Arming BaBot", "arming");
      this.offConfirmed = false;
      this.mayBeArmed = true;
      await this.send("ARM");
      if (generation !== this.generation) return;
      this.active = true;
      this.status("Following the video clock · 50 Hz", "following");
      while (generation === this.generation && this.following) {
        const began = performance.now();
        const pose = getPose();
        if (!this.usablePose(pose)) {
          await this.stop("No valid synchronized pose · motion stopped");
          return;
        }
        await this.send("POSE", pose!);
        await delay(Math.max(0, BABOT_PROTOCOL.commandIntervalMs - (performance.now() - began)));
      }
    } catch (error) {
      if (generation === this.generation) {
        this.fault(error instanceof Error ? error.message : "BaBot motion failed");
      }
    } finally {
      if (generation === this.generation) this.following = false;
    }
  }

  async stop(reason = "Stop requested"): Promise<StopResult> {
    this.generation++;
    this.following = false;
    this.active = false;
    if (this.stopping) return this.stopping;
    this.stopping = this.finishStop(reason);
    try { return await this.stopping; }
    finally { this.stopping = null; }
  }

  private async waitForOff(startingOffCount: number) {
    if (this.offCount > startingOffCount) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.offWaiter = null; resolve(); }, BABOT_PROTOCOL.stopReturnTimeoutMs);
      this.offWaiter = () => { clearTimeout(timer); this.offWaiter = null; resolve(); };
    });
    return this.offCount > startingOffCount;
  }

  private async finishStop(reason: string): Promise<StopResult> {
    this.status(reason, "stopping");
    // A pending ARM must settle before STOP. No later POSE can be enqueued.
    if (this.inFlight) { try { await this.inFlight; } catch {} }
    if (!this.writer || !this.mayBeArmed) {
      if (this.writer && this.returning) {
        // STOP ACK and firmware fault events revoke ARM immediately, but the
        // platform can still be returning. A second STOP would be NOT_ARMED.
        this.status("Waiting for firmware OFF · level return unconfirmed", "stopping");
        const offConfirmed = await this.waitForOff(this.offCount);
        if (!offConfirmed) this.verified = false;
        this.status(offConfirmed ? "Firmware reports OFF · level return complete" : "Firmware OFF not confirmed", this.verified ? "stopped" : "fault");
        return { acknowledged: false, offConfirmed };
      }
      this.status(this.offConfirmed ? "Firmware reports OFF · level return complete" : "No controller motion session", this.verified ? "stopped" : "fault");
      return { acknowledged: false, offConfirmed: this.offConfirmed };
    }
    const startingOffCount = this.offCount;
    this.returning = true;
    let acknowledged = false;
    try {
      await this.send("STOP");
      acknowledged = true;
      this.mayBeArmed = false;
      this.status("STOP acknowledged · waiting for firmware OFF", "stopping");
      await this.waitForOff(startingOffCount);
    } catch (error) {
      this.verified = false;
      this.status(`${error instanceof Error ? error.message : "STOP failed"} · level return unconfirmed`, "fault");
    }
    const offConfirmed = this.offCount > startingOffCount;
    if (offConfirmed) {
      this.mayBeArmed = false;
      this.returning = false;
      this.status("Firmware reports OFF · level return complete", this.verified ? "stopped" : "fault");
    } else if (acknowledged) {
      this.verified = false;
      this.status("STOP acknowledged · firmware OFF not confirmed", "fault");
    }
    return { acknowledged, offConfirmed };
  }

  async disconnect(): Promise<StopResult> {
    this.connectionGeneration++;
    const result = await this.stop("Disconnecting BaBot");
    if (this.opening) { try { await this.opening; } catch {} }
    await this.close();
    this.status("USB disconnected", "disconnected");
    return result;
  }

  private async close() {
    this.closing = true;
    this.verified = false;
    this.active = false;
    this.following = false;
    this.rejectPending("USB connection closed");
    try { await this.reader?.cancel(); } catch {}
    try { await this.readTask; } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.reader = null;
    this.writer = null;
    this.port = null;
    this.readTask = null;
    this.inFlight = null;
    this.mayBeArmed = false;
    this.returning = false;
  }
}
