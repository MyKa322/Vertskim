/** Write a warning to stderr. */
export function warn(message: string): void {
  console.warn(`[warn] ${message}`);
}

export function info(message: string): void {
  console.log(`[info] ${message}`);
}
