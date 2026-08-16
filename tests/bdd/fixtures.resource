*** Settings ***
Documentation     Self-provisioning fixtures for the BDD suites.
...
...               🚨 WHY THIS FILE EXISTS. These suites had NO recorded passing run since
...               they were written, and the reason was not a product defect: they assumed
...               apps that only ever existed on one hand-seeded VM (`kestra`, which is not
...               in the catalogue at all; `overlay-test`; `it-tools`). They were green on
...               somebody's machine once, and nowhere else — which is the same thing as
...               never having run.
...
...               ⚠️ DO NOT FIX A FAILING FIXTURE BY SEEDING THE VM BY HAND. That recreates
...               the original problem exactly. A test that needs a hand-prepared host
...               cannot run on appbay-podman or appbay-rhel, and the alpha gate requires
...               BOTH runtimes. Every fixture here is created by the suite and removed
...               after, so any fresh VM is a valid target.
...
...               ⭐ Fixtures are written straight into `etc/apps/<name>/` rather than
...               installed from the catalogue: the point is to control the manifest
...               precisely (a known secret-like variable, a known overlay condition), not
...               to test the catalogue.

Library           Process
Library           String
Library           Collections


*** Variables ***
${APPBAY_HOME}    /home/ubuntu/.appbay
# 🚨 `env` IS A DELIBERATE NO-OP PREFIX, not an accident. Rootful Podman needs `sudo` in
# front of every command; Docker must have nothing. An empty Robot variable would collapse
# to a zero-length argv element and break the exec, so the "no privilege" case uses `env`,
# which runs its argument unchanged. Override with --variable PRIV:sudo.
${PRIV}           env
# The container CLI differs per runtime; assertions that shell out must not assume docker.
${CONTAINER_BIN}  docker
${APPS_DIR}       ${APPBAY_HOME}/etc/apps


*** Keywords ***
Run On VM
    [Documentation]    Run a shell command inside the VM and return the result.
    [Arguments]    ${command}    ${timeout}=60s
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    bash    -c    ${command}
    ...    timeout=${timeout}
    RETURN    ${result}

Provision App Fixture
    [Documentation]    Write a synthetic app into the VM's apps directory.
    ...    Idempotent: overwrites whatever is there, so a crashed earlier run cannot
    ...    leave a half-written fixture that fails the next one in a confusing way.
    [Arguments]    ${name}    ${manifest}    ${compose}
    Run On VM    mkdir -p ${APPS_DIR}/${name}
    Write File On VM    ${APPS_DIR}/${name}/appbay.yaml    ${manifest}
    Write File On VM    ${APPS_DIR}/${name}/docker-compose.yml    ${compose}

Write File On VM
    [Documentation]    Write exact content to a path in the VM, via base64.
    ...    🚨 BASE64, NOT A HEREDOC. Content reaches here through Robot, `multipass exec`
    ...    and `bash -c`, and every layer has its own opinion about newlines, quotes and
    ...    backslashes. Heredoc attempts produced YAML that LOOKED right in the keyword and
    ...    arrived mangled — which then failed as a product bug rather than a harness one,
    ...    and cost more time than the tests themselves. Encoding removes every layer's
    ...    opinion: the bytes that go in are the bytes that land.
    [Arguments]    ${path}    ${content}
    ${encoded}=    Evaluate    __import__('base64').b64encode(($content).encode()).decode()
    ...    modules=base64
    ${result}=    Run On VM    echo '${encoded}' | base64 -d > ${path}
    Should Be Equal As Integers    ${result.rc}    0    msg=Could not write ${path}
    RETURN    ${result}

Remove App Fixture
    [Documentation]    Delete a fixture app and any render it produced.
    ...    Runs even when the test failed, so a failing run does not poison the next.
    [Arguments]    ${name}
    Run On VM    rm -rf ${APPS_DIR}/${name} ${APPBAY_HOME}/var/lib/renders/${name}

Provision Secret Scan Fixture
    [Documentation]    An app whose compose carries obviously secret-like variables.
    ...    Replaces the old `kestra` reference — kestra is not in the catalogue, so those
    ...    tests could only ever pass on the machine where someone had made it by hand.
    [Arguments]    ${name}=scantest
    ${manifest}=    Catenate    SEPARATOR=\n
    ...    name: ${name}
    ...    services:
    ...    ${SPACE}${SPACE}app: {}
    ${compose}=    Catenate    SEPARATOR=\n
    ...    services:
    ...    ${SPACE}${SPACE}app:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}image: docker.io/library/busybox:latest
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}command: ["sleep", "3600"]
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}environment:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}POSTGRES_PASSWORD: hunter2-not-a-real-secret
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}API_TOKEN: tok-not-a-real-secret
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}LOG_LEVEL: debug
    Provision App Fixture    ${name}    ${manifest}    ${compose}

Provision Overlay Fixture
    [Documentation]    An app carrying one overlay gated on a peer that IS deployed.
    ...    ⚠️ The peer is a parameter, not a constant. The old test hardcoded `authentik`,
    ...    a component retired two sprints ago, so the condition could never be satisfied
    ...    on any current install.
    [Arguments]    ${name}=overlay-test    ${peer}=whoami
    ${manifest}=    Catenate    SEPARATOR=\n
    ...    name: ${name}
    ...    services:
    ...    ${SPACE}${SPACE}app: {}
    ...    overlays:
    ...    ${SPACE}${SPACE}- name: peer-present
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}when: [${peer}]
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}services:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}app:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}environment:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}PEER_PRESENT: "yes"
    ${compose}=    Catenate    SEPARATOR=\n
    ...    services:
    ...    ${SPACE}${SPACE}app:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}image: docker.io/library/busybox:latest
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}command: ["sleep", "3600"]
    Provision App Fixture    ${name}    ${manifest}    ${compose}

Write App Env File
    [Documentation]    Write a `.env` beside an app's compose, for env_file precedence tests.
    [Arguments]    ${name}    ${content}
    Write File On VM    ${APPS_DIR}/${name}/.env    ${content}

Set Vault Secret
    [Documentation]    Store a secret via stdin, never as an argv value.
    ...    ⚠️ `appbay secrets set KEY VALUE` would put the secret in /proc/<pid>/cmdline —
    ...    the CLI's own help says so. A test that leaks secrets while asserting secrets do
    ...    not leak would be its own punchline.
    [Arguments]    ${key}    ${value}
    ${result}=    Run On VM    printf '%s' '${value}' | appbay secrets set ${key}
    Should Be Equal As Integers    ${result.rc}    0    msg=vault set failed: ${result.stderr}

Provision Deployed Secret App
    [Documentation]    Provision AND DEPLOY an app whose secrets come from the vault.
    ...    ⭐ These two tests cannot use a manifest-only fixture: what they assert is what a
    ...    RUNNING container sees (`docker exec env`, `docker inspect .Config.Env`), which
    ...    is the only place the injection mode is observable at all.
    [Arguments]    ${name}    ${injection}    ${refs}    ${env_file_content}=${EMPTY}    ${refs_keys}=${EMPTY}
    # ⚠️ MIRROR THE REAL MANIFEST SHAPE. A first attempt used `services: <n>: traits:`
    # (the form in docs/guide/secrets.qmd). The trait was recognised, but without the
    # top-level `upstream:` block the namespace transform never ran: the container came up
    # as `envtest-app-1` instead of `appbay.envtest.app`, so every assertion addressed a
    # container that did not exist. Real apps use `upstream:` + top-level `traits:`.
    ${manifest}=    Catenate    SEPARATOR=\n
    ...    project: default
    ...    environment: default
    ...    upstream:
    ...    ${SPACE}${SPACE}source: ./docker-compose.yml
    ...    ${SPACE}${SPACE}expose:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}- app
    ...    traits:
    ...    ${SPACE}${SPACE}- type: secrets
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}injection: ${injection}
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}service: app
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}refs:
    ...    ${refs}
    # ⚠️ `$var`, NOT '${var}'. The '${...}' form INTERPOLATES the value into the Python
    # expression, so a multi-line .env body produced
    #     'DB_PASS=x\nAPI_KEY=y' == ''   ->  SyntaxError: unterminated string literal
    # and the setup died before writing anything — surfacing as a test failure that looked
    # like a deploy problem. The `$var` form passes the object instead of its text.
    ${env_line}=    Set Variable If    $env_file_content == ''
    ...    ${EMPTY}    ${SPACE}${SPACE}${SPACE}${SPACE}env_file: [.env]
    # 🚨 THE PASS-THROUGH ENTRIES ARE THE POINT, NOT BOILERPLATE. `runtime-env` injection
    # supplies VALUES through the deploy process environment; it does not invent compose
    # keys. A service that never declares the variable therefore never receives it — which
    # is correct under the upstream model (upstream files are frozen and already declare
    # what they read; AppBay fills them in), and is exactly what a fixture omitting these
    # lines proved when the container kept the .env value and looked like a product bug.
    ${passthrough}=    Set Variable If    $injection == 'runtime-env'
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}environment: [${refs_keys}]    ${EMPTY}
    ${compose}=    Catenate    SEPARATOR=\n
    ...    services:
    ...    ${SPACE}${SPACE}app:
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}image: docker.io/library/busybox:latest
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}command: ["sleep", "3600"]
    ...    ${env_line}
    ...    ${passthrough}
    Provision App Fixture    ${name}    ${manifest}    ${compose}
    IF    $env_file_content != ''
        Write App Env File    ${name}    ${env_file_content}
    END
    ${up}=    Run On VM    cd /home/ubuntu && appbay up ${name} 2>&1    timeout=180s
    Should Be Equal As Integers    ${up.rc}    0    msg=deploy failed: ${up.stdout}

Remove Deployed Fixture
    [Documentation]    Stop the app, then delete it. Order matters — deleting the manifest
    ...    first would orphan a running container the next run cannot name.
    [Arguments]    ${name}
    Run On VM    cd /home/ubuntu && appbay down ${name} 2>&1 || true    timeout=120s
    Remove App Fixture    ${name}
