/**
 * Node 22 to 24 mark `node:sqlite` as experimental and print a warning about it
 * whenever a process loads it. Every Vertskim command loads it, so the warning
 * says nothing new and gets in the way of the output. Other warnings still show.
 */
export function silenceSqliteWarning(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (/^SQLite is an experimental feature/.test(message)) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}
