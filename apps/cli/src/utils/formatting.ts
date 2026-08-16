/**
 * Shared CLI formatting utilities.
 */

/**
 * Pad a string to a minimum width with trailing spaces.
 */
export function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}
