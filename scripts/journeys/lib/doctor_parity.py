#!/usr/bin/env python3
"""Compare the CLI's and the web's doctor reports for the same install.

Lives in its own file rather than a heredoc inside the journey for two reasons, both learned
here: a nested ``<<'PY'`` terminator inside a python string silently ends the OUTER heredoc,
and a comparator that has to marshal its results back through shell variables loses any value
containing a space — which is most check names.

Reads the web payload from ``argv[1]`` and the CLI JSON from ``$CLI_JSON``. Prints one
``OK|message`` or ``BAD|message`` line per assertion; the caller turns those into pass/fail.
"""

import json
import os
import sys


def main() -> int:
    web = json.load(open(sys.argv[1]))
    cli = json.loads(os.environ["CLI_JSON"])

    # ⚠️ COMPARE "SATISFIED", NOT THE RAW FIELDS. The CLI reports `passed` + `required`; the
    # web reports `status` of pass/warn/fail. An OPTIONAL check that fails is `passed: false`
    # in the CLI and `"warn"` in the web — comparing the raw fields would report a
    # disagreement on every host without a GPU, and the journey would cry wolf forever.
    web_ok = {c["name"]: c["status"] != "fail" for c in web["checks"]}
    cli_ok = {
        c["name"]: bool(c["passed"]) or not c.get("required", True)
        for c in cli["checks"]
    }

    only_cli = sorted(set(cli_ok) - set(web_ok))
    only_web = sorted(set(web_ok) - set(cli_ok))
    disagree = sorted(n for n in set(cli_ok) & set(web_ok) if cli_ok[n] != web_ok[n])
    shared = len(set(cli_ok) & set(web_ok))

    def verdict(good: bool, ok_msg: str, bad_msg: str) -> None:
        print(("OK|" + ok_msg) if good else ("BAD|" + bad_msg))

    # A floor first: two interfaces that both report nothing agree perfectly.
    verdict(
        shared >= 10,
        f"the two interfaces share {shared} checks by name",
        f"only {shared} shared checks — every comparison below would be vacuous",
    )
    verdict(
        not only_cli,
        "no check exists only in the CLI",
        "checks the web never runs: " + ", ".join(only_cli),
    )
    verdict(
        not only_web,
        "no check exists only in the web",
        "checks the CLI never runs: " + ", ".join(only_web),
    )
    verdict(
        not disagree,
        "every shared check reaches the same verdict in both",
        "🚨 the interfaces DISAGREE about: " + ", ".join(disagree),
    )

    # The three properties the merge was for. None was possible while the web carried its own
    # implementation: it had no ids, no DNS check, and no required/optional distinction.
    verdict(
        all("id" in c for c in web["checks"]),
        "every web check carries a stable id",
        "web checks carry no id — the UI is back to matching prose names",
    )
    verdict(
        any(c.get("id") == "network-dns" for c in web["checks"]),
        "the web runs the shared-network DNS check it never had",
        "no network-dns check in the web payload",
    )
    verdict(
        all(c["status"] != "fail" for c in web["checks"] if not c["required"]),
        "optional checks report as warnings, not failures",
        "an optional check was reported as a hard failure",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
