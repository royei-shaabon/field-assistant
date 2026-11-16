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
