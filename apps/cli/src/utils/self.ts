/**
 * The appbay binary to re-invoke for a sub-command run as a child (`setup` runs `init` and
 * `up`; `install` runs `validate`). A `bun build --compile` executable reports itself as
 * `process.execPath`, so that is the binary the operator ran; a PATH lookup could only pick
 * a different one.
 */
export function selfBinary(): string {
  return process.execPath;
}
