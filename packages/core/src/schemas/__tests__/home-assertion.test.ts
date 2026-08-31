/**
 * The moved-or-copied home check — RFC-001 §2.4.
 *
 * ⚠️ Absence must never read as disagreement. A pre-§2.4 install records no `home:`, and a
 * check that treated that as a mismatch would fire on every existing installation — the
 * failure mode is worse than the one it detects, because it is universal.
 */

import { describe, expect, it } from "vitest";
import { checkHomeAssertion } from "../instance.js";

const cfg = (home?: string) =>
  `project: homelab\ndomain: example.org\n${home ? `home: ${home}\n` : ""}`;

describe("checkHomeAssertion", () => {
  it("is silent when the recorded home matches", () => {
    expect(checkHomeAssertion("/srv/appbay", cfg("/srv/appbay"))).toBeNull();
  });

  it("reports a mismatch with both paths", () => {
    const m = checkHomeAssertion("/srv/copy", cfg("/srv/appbay"));
    expect(m).toEqual({ recorded: "/srv/appbay", resolved: "/srv/copy" });
  });

  it("ignores a trailing separator — the same tree either way", () => {
    expect(checkHomeAssertion("/srv/appbay/", cfg("/srv/appbay"))).toBeNull();
    expect(checkHomeAssertion("/srv/appbay", cfg("/srv/appbay/"))).toBeNull();
  });

  it("is silent when nothing is recorded — a pre-§2.4 install must keep working", () => {
    expect(checkHomeAssertion("/srv/appbay", cfg())).toBeNull();
  });

  it("is silent when there is no config at all", () => {
    expect(checkHomeAssertion("/srv/appbay", null)).toBeNull();
  });

  it("is silent on an unparseable config rather than reporting a false mismatch", () => {
    expect(checkHomeAssertion("/srv/appbay", "project: [unclosed")).toBeNull();
  });
});
