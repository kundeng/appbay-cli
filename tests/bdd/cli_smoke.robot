*** Settings ***
Documentation     Appbay CLI smoke tests against a live multipass VM.
...               Validates core CLI commands return expected output on a
...               deployed instance with 19 apps.
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
${TIMEOUT}        30s


*** Keywords ***
Verify VM Is Reachable
    ${result}=    Run Process    multipass    exec    ${VM}    --    echo    ok
    Should Be Equal As Integers    ${result.rc}    0
    Should Contain    ${result.stdout}    ok

Run Appbay
    [Documentation]    Run an appbay CLI command on the VM and return the result.
    [Arguments]    @{args}
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    appbay    @{args}
    ...    timeout=${TIMEOUT}
    RETURN    ${result}

Run Appbay And Expect Success
    [Documentation]    Run an appbay CLI command, assert exit code 0, return result.
    [Arguments]    @{args}
    ${result}=    Run Appbay    @{args}
    Should Be Equal As Integers    ${result.rc}    0    msg=appbay ${args} failed: ${result.stderr}
    RETURN    ${result}


*** Test Cases ***
Status Shows All Deployed Apps
    [Documentation]    appbay status lists apps with services/traits/errors columns.
    ...    Asserts the SHAPE of the report, not which apps a particular VM happens to
    ...    hold. The old version required traefik, whoami and authentik by name: it
    ...    therefore failed on any host that had not been hand-seeded with exactly those
    ...    three, and it named `authentik` — a component replaced in S19 and retired in
    ...    S25. A suite that encodes one machine's fixture data tests the machine.
    ${result}=    Run Appbay And Expect Success    status
    Should Contain    ${result.stdout}    SERVICES
    Should Contain    ${result.stdout}    TRAITS
    Should Contain    ${result.stdout}    ERRORS
    Should Contain    ${result.stdout}    app(s)
    Should Match Regexp    ${result.stdout}    (?m)^\\s*\\d+ app\\(s\\)

List Shows All Deployed Apps With Metadata
    [Documentation]    appbay list shows apps with project, environment, and compose file.
    ${result}=    Run Appbay And Expect Success    list
    Should Contain    ${result.stdout}    PROJECT
    Should Contain    ${result.stdout}    ENVIRONMENT
    Should Contain    ${result.stdout}    COMPOSE FILE
    Should Contain    ${result.stdout}    traefik
    Should Contain    ${result.stdout}    nextcloud
    Should Contain    ${result.stdout}    app(s) found

Secrets Vault Lists Entries
    [Documentation]    appbay secrets vault shows stored secrets grouped by scope.
    ...    Asserts the listing renders and reports a count. It must NOT require a
    ...    specific key: DB_PASSWORD was one host's fixture, so the test failed on an
    ...    install whose vault legitimately holds different secrets.
    ...    🚨 Also asserts no secret VALUE is printed — `vault` lists names, and a
    ...    regression that started echoing values would otherwise pass this suite.
    ${result}=    Run Appbay And Expect Success    secrets    vault
    Should Contain    ${result.stdout}    secret(s)
    Should Not Contain    ${result.stdout}    BEGIN PRIVATE KEY

Secrets CRUD Cycle
    [Documentation]    Set, get, and delete a secret to verify full CRUD lifecycle.
    # Set
    ${set_result}=    Run Appbay And Expect Success    secrets    set    TEST_SMOKE    test123
    # Get
    ${get_result}=    Run Appbay And Expect Success    secrets    get    TEST_SMOKE
    Should Contain    ${get_result.stdout}    test123
    # Delete
    ${del_result}=    Run Appbay And Expect Success    secrets    delete    TEST_SMOKE
    # Verify gone
    ${gone_result}=    Run Appbay    secrets    get    TEST_SMOKE
    Should Not Be Equal As Integers    ${gone_result.rc}    0

Retired Auth Command Fails Loudly
    [Documentation]    `appbay auth` was an alias for the Authentik/Authelia commands.
    ...    S25 retired it. This test used to assert the OLD surface (PROVIDER, TRAEFIK,
    ...    AUTHENTIK) and so tested a product two generations gone.
    ...    🚨 A retirement must FAIL, not no-op. A stub that exits 0 would let scripts
    ...    calling `appbay auth` keep "succeeding" while configuring nothing — the exact
    ...    silent-success failure this project keeps hitting. Assert non-zero AND that the
    ...    operator is told where to go instead.
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    appbay    auth    status
    ...    timeout=${TIMEOUT}
    Should Not Be Equal As Integers    ${result.rc}    0
    ${output}=    Set Variable    ${result.stdout}${result.stderr}
    Should Contain    ${output}    retired
    Should Contain    ${output}    appbay edge users

Edge Users List Is The Successor Surface
    [Documentation]    Identity administration moved to `appbay edge users` (S25).
    ...    An EMPTY store is a normal state — a fresh install, or an edge that has never
    ...    provisioned — so this asserts the command SUCCEEDS and says which case it is,
    ...    rather than requiring a particular user to exist (the old test demanded
    ...    `akadmin`, an Authentik account that no install creates any more).
    ${result}=    Run Appbay And Expect Success    edge    users    list
    ${empty}=    Run Keyword And Return Status
    ...    Should Contain    ${result.stdout}    No edge users yet
    IF    not ${empty}
        Should Match Regexp    ${result.stdout}    \\S+@\\S+
    END

Validate All Passes
    [Documentation]    appbay validate --all passes for all deployed apps.
    ${result}=    Run Appbay And Expect Success    validate    --all
    Should Contain    ${result.stdout}    0 failed
    Should Not Contain    ${result.stdout}    ✗

Doctor Passes Required Checks
    [Documentation]    appbay doctor passes all required system health checks.
    ...    ⚠️ RUNTIME-NEUTRAL ON PURPOSE. These asserted the literal "Docker" and
    ...    "Docker Compose v2", so they failed on a Podman install where doctor correctly
    ...    reports "Podman" and "Podman Compose v2" — a test that fails BECAUSE the runtime
    ...    abstraction works. The invariant is that doctor names the configured runtime and
    ...    reaches a verdict, not which runtime it happens to be.
    ${result}=    Run Appbay And Expect Success    doctor
    Should Contain    ${result.stdout}    Appbay Doctor
    Should Contain    ${result.stdout}    APPBAY_HOME
    Should Contain    ${result.stdout}    All required checks passed
    ${runtime}=    Set Variable If    '${CONTAINER_BIN}' == 'podman'    Podman    Docker
    Should Contain    ${result.stdout}    ${runtime}
    Should Contain    ${result.stdout}    ${runtime} Compose v2
    Should Contain    ${result.stdout}    All required checks passed
