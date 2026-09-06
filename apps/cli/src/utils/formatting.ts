/**
 * Shared CLI formatting utilities.
 */

/**
 * Pad a string to a minimum width with trailing spaces.
 */
export function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Bytes as a short human figure: 1.2 GB, 340 MB, 12 KB, 7 B. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${String(bytes)} B`;
}
