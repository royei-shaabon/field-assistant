// One line of JSON per event, on standard output: Cloud Run's log viewer reads the fields, so
// a line can be found by environment, event, knowledge base or how long it took.
//   severity  INFO | WARNING | ERROR (the names Cloud Logging knows)
//   event     a short fixed name: "ask.done", "live.token", "auth.failed" ...
//   env       the environment it happened in
//   ms        how long the step took, when it was timed
// Never logged: passwords, codes, keys, tokens, pictures or sound.
type Fields = Record<string, unknown>;

function write(severity: "INFO" | "WARNING" | "ERROR", event: string, fields: Fields) {
  const line = JSON.stringify({ severity, event, message: event, time: new Date().toISOString(), ...fields });
  if (severity === "ERROR") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Fields = {}) => write("INFO", event, fields),
  warn: (event: string, fields: Fields = {}) => write("WARNING", event, fields),
  error: (event: string, error: unknown, fields: Fields = {}) => write("ERROR", event, { ...fields, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }),
};

// Times a step and logs it, whether it worked or threw.
export async function timed<T>(event: string, fields: Fields, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await work();
    log.info(event, { ...fields, ms: Date.now() - started });
    return result;
  } catch (e) {
    log.error(event, e, { ...fields, ms: Date.now() - started });
    throw e;
  }
}

// A stage of work, timed from its start to its end with every part inside it. Two lines are
// written: "<event>.start" when it begins (so a stage that never finishes is visible), and
// "<event>" when it ends, with the total and the time of each part:
//   {"event":"live.lookup","ms":2140,"parts":{"load":3,"search":410,"rerank":1690,"record":37}}
// A part is everything between two `part()` calls; calling the same name twice adds up.
export type Span = {
  part(name: string): void;
  // Adds a time measured elsewhere (inside a library call, or on parallel work).
  add(name: string, ms: number): void;
  end(extra?: Fields): number;
  fail(error: unknown, extra?: Fields): number;
};

export function span(event: string, fields: Fields = {}): Span {
  const started = Date.now();
  let last = started;
  const parts: Record<string, number> = {};
  log.info(`${event}.start`, fields);
  const close = () => Date.now() - started;
  return {
    part(name) {
      const now = Date.now();
      parts[name] = (parts[name] ?? 0) + now - last;
      last = now;
    },
    add(name, ms) {
      parts[name] = (parts[name] ?? 0) + Math.round(ms);
    },
    end(extra = {}) {
      const ms = close();
      log.info(event, { ...fields, ...extra, ms, parts });
      return ms;
    },
    fail(error, extra = {}) {
      const ms = close();
      log.error(event, error, { ...fields, ...extra, ms, parts });
      return ms;
    },
  };
}
