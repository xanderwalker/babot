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
  errorCode?: BabotConnectionErrorCode;
  retryable?: boolean;
};
export type BabotConnectionErrorCode = "unsupported" | "cancelled" | "permission-denied" | "port-busy" | "firmware-mismatch" | "device-missing" | "timeout" | "transport-error";
export class BabotConnectionError extends Error {
  constructor(public code: BabotConnectionErrorCode, message: string, public retryable: boolean) {
    super(message);
    this.name = "BabotConnectionError";
  }
}
/** Stable recovery categories; only the coordinator decides when to retry. */
export function classifyBabotConnectionError(error: unknown, stage = "transport"): BabotConnectionError {
  if (error instanceof BabotConnectionError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "USB connection failed");
  if (stage === "chooser" && (name === "NotFoundError" || name === "AbortError" || /cancel|no port selected/i.test(message))) {
    return new BabotConnectionError("cancelled", "USB selection cancelled · select Connect when ready", false);
  }
  if (name === "SecurityError" || name === "NotAllowedError" || /permission denied|permission revoked/i.test(message)) {
    return new BabotConnectionError("permission-denied", "USB permission unavailable · allow access in this browser", false);
  }
  if (stage === "open" && (name === "InvalidStateError" || /busy|already open|in use|failed to open serial port|access denied/i.test(message))) {
    return new BabotConnectionError("port-busy", "BaBot USB is in use · close its other tab, browser, or serial monitor", false);
  }
  if (name === "NotFoundError" || /device.*(missing|disconnected|not found)|no.*device/i.test(message)) {
    return new BabotConnectionError("device-missing", "BaBot USB is not available · waiting for the device", true);
  }
  if (name === "TimeoutError" || /timed? out|timeout/i.test(message)) {
    return new BabotConnectionError("timeout", message, true);
  }
  if (name === "NotSupportedError") return new BabotConnectionError("unsupported", message, false);
  return new BabotConnectionError("transport-error", message, true);
}
type StatusListener = (message: string, connected: boolean, active: boolean, detail: BabotStatus) => void;
type Pending = { id: number; verb: string; resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Connection = {
  port: Port;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  readTask: Promise<void> | null;
  openTask: Promise<void> | null;
  closeTask: Promise<void> | null;
  opened: boolean;
  closing: boolean;
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const CONTROLLER_FILTERS = [
  { usbVendorId: 0x2341, usbProductId: 0x8036 },
  { usbVendorId: 0x2a03, usbProductId: 0x8036 },
];

/** One acknowledged command at a time. No stale-pose backlog or automatic re-arm. */
export class BabotSerial {
  private connection: Connection | null = null;
  private get port() { return this.connection?.port ?? null; }
  private get writer() { return this.connection?.writer ?? null; }
  private pending: Pending | null = null;
  private inFlight: Promise<string> | null = null;
  private opening: Promise<boolean> | null = null;
  private stopping: Promise<StopResult> | null = null;
  private disconnecting: Promise<StopResult> | null = null;
  private sequence = 0;
  private generation = 0;
  private connectionGeneration = 0;
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

  private status(message: string, phase: BabotStatus["phase"], error?: BabotConnectionError) {
    this.onStatus(message, this.verified && Boolean(this.port), this.active,
      { phase, lastLine: this.lastLine, offConfirmed: this.offConfirmed,
        ...(error ? { errorCode: error.code, retryable: error.retryable } : {}) });
  }

  private rejectPending(message: string) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }

  private fault(message: string, firmwareDisarmed = false, error?: BabotConnectionError) {
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
    this.status(message, "fault", error);
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
    } else if (line.startsWith("READY ") && (this.verified || this.mayBeArmed || this.returning || this.following)) {
      this.mayBeArmed = false;
      this.returning = false;
      this.offConfirmed = false;
      this.fault("Firmware restarted · reconnect before replay");
    }
  }

  private async read(connection: Connection) {
    const reader = connection.reader!;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!connection.closing && this.connection === connection) {
        const { value, done } = await reader.read();
        if (connection.closing || this.connection !== connection) break;
        if (done) {
          this.fault("USB disconnected · motion stopped");
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
      if (!connection.closing && this.connection === connection) this.fault(error instanceof Error ? error.message : "USB read failed");
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
      let pending: Pending;
      const timer = setTimeout(() => {
        if (this.pending === pending) this.pending = null;
        reject(new Error(`${verb} acknowledgement timed out`));
      }, timeout);
      pending = { id, verb, resolve, reject, timer };
      this.pending = pending;
      void writer.write(new TextEncoder().encode(wire)).catch(() => {
        if (this.pending === pending) this.rejectPending("USB write failed");
      });
    });
    const tracked = reply.finally(() => { if (this.inFlight === tracked) this.inFlight = null; });
    this.inFlight = tracked;
    return tracked;
  }

  connect(): Promise<boolean> {
    if (this.opening) {
      const generation = this.connectionGeneration;
      return this.opening.then((connected) => connected || generation !== this.connectionGeneration
        ? connected : this.beginConnection(true));
    }
    return this.beginConnection(true);
  }

  /** Reuse browser permission without opening a picker or starting motion. */
  reconnect(): Promise<boolean> {
    return this.beginConnection(false);
  }

  private beginConnection(allowChooser: boolean): Promise<boolean> {
    const generation = this.connectionGeneration;
    if (this.disconnecting) {
      return this.disconnecting.then(() => generation === this.connectionGeneration
        ? this.beginConnection(allowChooser) : false);
    }
    if (this.opening) return this.opening;
    // Revalidation must never insert a command into a motion or level return.
    if (this.following || this.active || this.mayBeArmed || this.returning || this.stopping || this.inFlight) {
      return Promise.resolve(this.verified);
    }
    const opening = this.open(generation, allowChooser).finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  private async open(generation: number, allowChooser: boolean) {
    let stage = "context";
    let owned: Connection | null = null;
    try {
      if (!isApprovedControllerOrigin({ isSecureContext: window.isSecureContext, isTopLevel: window.top === window.self })) {
        throw new BabotConnectionError("unsupported", "Open the player directly in a secure browser tab (HTTPS or localhost) to connect BaBot", false);
      }
      const api = (navigator as Navigator & { serial?: Serial }).serial;
      if (!api) throw new BabotConnectionError("unsupported", "USB control requires desktop Chrome with Web Serial", false);
      if (this.verified && this.connection) {
        const existing = this.connection;
        this.status("Checking BaBot connection", "connecting");
        try {
          await this.identify();
          if (generation !== this.connectionGeneration || this.connection !== existing) return false;
          this.status("BaBot firmware verified · ready for replay", "ready");
          return true;
        } catch (error) {
          if (generation !== this.connectionGeneration) return false;
          const failure = classifyBabotConnectionError(error, "probe");
          this.fault(failure.message, false, failure);
          if (generation !== this.connectionGeneration) return false;
          if (failure.code === "firmware-mismatch") throw failure;
          // One stale idle link can be reopened. Repeated attempts belong to the
          // connection coordinator, with its bounded retry/backoff policy.
          await this.close(existing);
        }
      }
      this.status("Checking remembered BaBot permission", "connecting");
      stage = "permission";
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
        stage = "chooser";
        selected = await api.requestPort({ filters: CONTROLLER_FILTERS });
      }
      if (generation !== this.connectionGeneration) return false;
      if (this.connection) await this.close(this.connection);
      if (generation !== this.connectionGeneration) return false;
      owned = { port: selected, reader: null, writer: null, readTask: null, openTask: null, closeTask: null, opened: false, closing: false };
      this.connection = owned;
      this.sequence = 0;
      this.offConfirmed = false;
      stage = "open";
      const connection = owned;
      connection.openTask = selected.open({ baudRate: BABOT_PROTOCOL.baudRate }).then(() => { connection.opened = true; });
      await connection.openTask;
      if (generation !== this.connectionGeneration || connection.closing) { await this.close(connection); return false; }
      if (!selected.readable || !selected.writable) throw new Error("USB data streams unavailable");
      connection.reader = selected.readable.getReader();
      connection.writer = selected.writable.getWriter();
      connection.readTask = this.read(connection);
      stage = "identity";
      await this.identify();
      if (generation !== this.connectionGeneration || this.connection !== connection) { await this.close(connection); return false; }
      this.verified = true;
      this.status("BaBot firmware verified · ready for replay", "ready");
      return true;
    } catch (error) {
      // A superseded chooser/read/open result cannot tear down a newer link or
      // publish a fault into its UI. Disconnect owns cleanup of an opening port.
      if (generation !== this.connectionGeneration) return false;
      let failure = classifyBabotConnectionError(error, stage);
      try { await this.close(owned ?? this.connection); }
      catch (closeError) { failure = classifyBabotConnectionError(closeError, "close"); }
      this.verified = false;
      this.status(failure.message, "fault", failure);
      throw failure;
    }
  }

  private async identify() {
    const line = await this.send("PING", undefined, 1500);
    if (!/^ACK \d+ PING BABOT_MOTION 1$/.test(line)) {
      throw new BabotConnectionError("firmware-mismatch", "BaBot Motion firmware v1 was not identified", false);
    }
  }

  private usablePose(pose: BabotPose | null) {
    if (!pose || !Number.isFinite(pose.roll) || !Number.isFinite(pose.pitch) || !Number.isFinite(pose.sampledAt)) return false;
    const age = performance.now() - pose.sampledAt;
    return age >= -20 && age <= BABOT_PROTOCOL.staleSampleMs;
  }

  async start(getPose: () => BabotPose | null): Promise<void> {
    const beforeStop = this.generation;
    if (this.opening) await this.opening;
    if (this.stopping) await this.stopping;
    if (beforeStop !== this.generation) return;
    if (!this.verified || !this.writer) throw new Error("Connect and verify BaBot before starting");
    if (this.following || this.active) throw new Error("BaBot is already following");
    if (this.returning) throw new Error("Wait for firmware EVENT OFF before replay");
    if (!this.usablePose(getPose())) throw new Error("No fresh synchronized video pose; play the video first");
    const generation = ++this.generation;
    this.following = true;
    try {
      await this.identify();
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
        const failure = classifyBabotConnectionError(error);
        this.fault(failure.message, false, failure);
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
    if (this.disconnecting) return this.disconnecting;
    this.connectionGeneration++;
    // A browser picker cannot be cancelled programmatically. Invalidate its
    // result without holding the port lease until a person dismisses it.
    this.opening = null;
    if (this.pending?.verb === "PING") this.rejectPending("USB connection cancelled");
    const disconnecting = (async () => {
      const result = await this.stop("Disconnecting BaBot");
      try {
        await this.close();
        this.status("USB disconnected", "disconnected");
        return result;
      } catch (error) {
        const failure = classifyBabotConnectionError(error, "close");
        this.status(failure.message, "fault", failure);
        throw failure;
      }
    })().finally(() => {
      if (this.disconnecting === disconnecting) this.disconnecting = null;
    });
    this.disconnecting = disconnecting;
    return disconnecting;
  }

  private async close(connection = this.connection): Promise<void> {
    if (!connection) return;
    if (connection.closeTask) return connection.closeTask;
    connection.closing = true;
    if (this.connection === connection) {
      this.verified = false;
      this.active = false;
      this.following = false;
      this.rejectPending("USB connection closed");
    }
    const closing = (async () => {
      // Disconnect during port.open must wait for that real ownership to be
      // released. Waiting for the whole connection attempt would deadlock.
      try { await connection.openTask; } catch {}
      try { await connection.reader?.cancel(); } catch {}
      try { await connection.readTask; } catch {}
      try { connection.reader?.releaseLock(); } catch {}
      try { connection.writer?.releaseLock(); } catch {}
      connection.reader = null;
      connection.writer = null;
      connection.readTask = null;
      if (connection.opened) {
        // Failure must retain the resource and reject: callers cannot release
        // the cross-tab ownership lease until port closure is confirmed.
        await connection.port.close();
        connection.opened = false;
      }
      if (this.connection === connection) {
        this.connection = null;
        this.inFlight = null;
        this.mayBeArmed = false;
        this.returning = false;
      }
    })().finally(() => {
      if (connection.closeTask === closing) connection.closeTask = null;
    });
    connection.closeTask = closing;
    return closing;
  }
}
