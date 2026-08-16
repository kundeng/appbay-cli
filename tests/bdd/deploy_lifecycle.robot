*** Settings ***
Documentation     Deploy lifecycle integration tests against a live multipass VM.
...               Validates compile, deploy, eject, validate, and auth workflows.
Library           Process
Library           String

Suite Setup       Verify VM Is Reachable

*** Variables ***
${APPBAY_HOME}    /home/ubuntu/.appbay
# 🚨 `env` IS A DELIBERATE NO-OP PREFIX, not an accident. Rootful Podman needs `sudo` in
# front of every command; Docker must have nothing. An empty Robot variable would collapse
# to a zero-length argv element and break the exec, so the "no privilege" case uses `env`,
# which runs its argument unchanged. Override with --variable PRIV:sudo.
${PRIV}           env
# The container CLI differs per runtime; assertions that shell out must not assume docker.
${CONTAINER_BIN}  docker
${VM}             appbay-docker
${TIMEOUT}        120s

*** Keywords ***
Verify VM Is Reachable
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    appbay    version
    Should Be Equal As Integers    ${result.rc}    0

Run Appbay
    [Arguments]    @{args}
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    appbay    @{args}
    ...    timeout=${TIMEOUT}
    RETURN    ${result}

Run Appbay OK
    [Arguments]    @{args}
    ${result}=    Run Appbay    @{args}
    Should Be Equal As Integers    ${result.rc}    0    msg=appbay ${args} failed: ${result.stderr}
    RETURN    ${result}

*** Test Cases ***
Compile Produces Rendered Output
    [Documentation]    appbay compile renders compose files without deploying.
    ${result}=    Run Appbay OK    compile    whoami
    Should Contain    ${result.stdout}    compiled

Validate All Apps Pass Schema Check
    [Documentation]    Every deployed app passes appbay.yaml + compose validation.
    ${result}=    Run Appbay OK    validate    --all
    Should Contain    ${result.stdout}    0 failed
    Should Not Contain    ${result.stdout}    ✗

Eject Produces Standalone Compose
    [Documentation]    appbay eject writes a self-contained compose directory that
    ...               can run without appbay installed.
    ${result}=    Run Appbay OK    eject    whoami    --output    /tmp/bdd-eject/whoami
    Should Contain    ${result.stdout}    Ejected
    Should Contain    ${result.stdout}    docker-compose.yml

    # Verify ejected compose exists and has services
    ${cat}=    Run Process    multipass    exec    ${VM}    --
    ...    cat    /tmp/bdd-eject/whoami/docker-compose.yml
    Should Be Equal As Integers    ${cat.rc}    0
    Should Contain    ${cat.stdout}    services:
    Should Contain    ${cat.stdout}    whoami

Deploy Existing App Redeploy
    [Documentation]    Redeploying an app after its render is discarded must recompile and
    ...    succeed. Uses `whoami`, which this suite already depends on; the old version
    ...    named `it-tools`, an app no current install has, so it reported
    ...    "No apps found to deploy" rather than testing a redeploy at all.
    Run Process    multipass    exec    ${VM}    --    rm    -rf
    ...    ${APPBAY_HOME}/var/lib/renders/whoami    timeout=${TIMEOUT}
    ${deploy}=    Run Appbay OK    up    whoami
    Should Contain    ${deploy.stdout}    deployed
    # The render must be rebuilt, not merely reported — this is the recompile under test.
    ${ls}=    Run Process    multipass    exec    ${VM}    --    ls
    ...    ${APPBAY_HOME}/var/lib/renders/whoami/    timeout=${TIMEOUT}
    Should Contain    ${ls.stdout}    docker-compose.rendered.yml

    # Verify container runs
    # ⚠️ Filter on the app actually redeployed. This still said `it-tools` — an app no
    # current install has — so it matched nothing and the header alone came back.
    ${ps}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    ${CONTAINER_BIN}    ps    --filter    name\=whoami
    ...    timeout=${TIMEOUT}
    Should Contain    ${ps.stdout}    Up

Auth Trait Emits An Edge Authorization Policy
    [Documentation]    S25: an app declares access INTENT in its manifest and the selected
    ...    edge decides enforcement, so there is no `appbay auth status` any more — this
    ...    test used to assert one, naming `authentik`, a component retired two sprints ago.
    ...    What is checkable now is the ARTIFACT: an app with an auth trait must produce an
    ...    authorization policy in the edge's config tree.
    ${result}=    Run Process    multipass    exec    ${VM}    --    ls
    ...    ${APPBAY_HOME}/etc/apps/caddy/config/security/policies/    timeout=${TIMEOUT}
    Should Be Equal As Integers    ${result.rc}    0
    Should Contain    ${result.stdout}    whoami.caddy

Authorization Policy Names The Required Role
    [Documentation]    🚨 THE POLICY MUST NAME A ROLE, and this is the assertion that
    ...    matters most in the whole suite. A policy that exists but matches nothing lets
    ...    every request fall through to the permissive default — which is exactly the
    ...    live security defect S24 shipped, where group restrictions silently did not
    ...    apply. Presence is not enforcement; the rule has to reference a role.
    ${result}=    Run Process    multipass    exec    ${VM}    --    cat
    ...    ${APPBAY_HOME}/etc/apps/caddy/config/security/policies/whoami.caddy
    ...    timeout=${TIMEOUT}
    Should Be Equal As Integers    ${result.rc}    0
    Should Contain    ${result.stdout}    allow roles
    Should Match Regexp    ${result.stdout}    authp/\\w+

Access Intent Is Declared In The Manifest Not The Provider
    [Documentation]    The S25 invariant, stated as a test: an app manifest declares WHAT
    ...    access it needs and never names the edge that enforces it. The old test asserted
    ...    an Authentik `outpost`, i.e. it required the manifest layer to know about the
    ...    provider — the coupling this design forbids.
    ${result}=    Run Process    multipass    exec    ${VM}    --    cat
    ...    ${APPBAY_HOME}/etc/apps/whoami/appbay.yaml    timeout=${TIMEOUT}
    Should Be Equal As Integers    ${result.rc}    0
    Should Contain    ${result.stdout}    type: auth
    Should Not Contain    ${result.stdout}    authentik
    Should Not Contain    ${result.stdout}    authelia
    Should Not Contain    ${result.stdout}    caddy

Doctor Validates System Health
    [Documentation]    appbay doctor checks the runtime, Compose, APPBAY_HOME and system deps.
    ...    ⚠️ RUNTIME-NEUTRAL ON PURPOSE. These asserted the literal "Docker" and
    ...    "Docker Compose v2", so they failed on a Podman install where doctor correctly
    ...    reports "Podman" and "Podman Compose v2" — a test that fails BECAUSE the runtime
    ...    abstraction works. The invariant is that doctor names the configured runtime and
    ...    reaches a verdict, not which runtime it happens to be.
    ${result}=    Run Appbay OK    doctor
    Should Contain    ${result.stdout}    APPBAY_HOME
    Should Contain    ${result.stdout}    All required checks passed
    ${runtime}=    Set Variable If    '${CONTAINER_BIN}' == 'podman'    Podman    Docker
    Should Contain    ${result.stdout}    ${runtime}
    Should Contain    ${result.stdout}    ${runtime} Compose v2
