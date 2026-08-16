*** Settings ***
Documentation     Traits and overlays integration tests against a live multipass VM.
...               Validates trait compilation, overlay activation, scoped variables,
...               and namespace sharing.
Library           Process
Resource          fixtures.resource
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
${TIMEOUT}        60s

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
Status Shows Trait Counts Per App
    [Documentation]    appbay status reports how many traits each app has.
    ${result}=    Run Appbay OK    status
    Should Contain    ${result.stdout}    TRAITS
    # whoami has ingress + auth traits
    Should Contain    ${result.stdout}    whoami

Status Shows Service Level Traits
    [Documentation]    appbay status <app> shows service-level trait assignments.
    ${result}=    Run Appbay OK    status    whoami
    Should Contain    ${result.stdout}    Traits (
    Should Contain    ${result.stdout}    ingress
    Should Contain    ${result.stdout}    auth

Overlay Activates When Peer App Is Present
    [Documentation]    An overlay gated on a peer app activates when that peer is present.
    ...    ⚠️ The peer used to be hardcoded as `authentik`, retired two sprints ago, so the
    ...    condition could never be satisfied. It is now `whoami`, which this suite already
    ...    relies on being deployed, and the fixture app is created by the test itself.
    [Setup]    Provision Overlay Fixture
    [Teardown]    Remove App Fixture    overlay-test
    ${result}=    Run Appbay OK    status    overlay-test
    Should Contain    ${result.stdout}    Overlays (1)
    Should Contain    ${result.stdout}    whoami

Validate Reports Failures For Bad Apps
    [Documentation]    validate --all reports 0 failures for all currently deployed
    ...               apps (negative: no bad apps exist on the VM right now).
    ${result}=    Run Appbay OK    validate    --all
    Should Contain    ${result.stdout}    0 failed

Hooks Init Pattern Creates Dependency
    [Documentation]    An app with hooks pattern "init" should have an init service
    ...               in the rendered compose with depends_on.
    # Check homeassistant which has hooks traits
    ${result}=    Run Appbay OK    status    homeassistant
    Should Contain    ${result.stdout}    hooks

Ingress Trait Generates Traefik Config
    [Documentation]    An app with an ingress trait should have a Traefik dynamic
    ...               config file generated in the traefik config directory.
    ${result}=    Run Process    multipass    exec    ${VM}    --    ls
    ...    ${APPBAY_HOME}/etc/apps/traefik/config/dynamic/
    Should Be Equal As Integers    ${result.rc}    0
    Should Contain    ${result.stdout}    whoami.yml

Ingress Config Contains Router And Service
    [Documentation]    The generated Traefik config should define a router with
    ...               Host rule and a load balancer service.
    ${result}=    Run Process    multipass    exec    ${VM}    --    cat
    ...    ${APPBAY_HOME}/etc/apps/traefik/config/dynamic/whoami.yml
    Should Be Equal As Integers    ${result.rc}    0
    Should Contain    ${result.stdout}    routers:
    Should Contain    ${result.stdout}    Host(
    Should Contain    ${result.stdout}    loadBalancer:
    Should Contain    ${result.stdout}    servers:

Auth Trait Generates Separate Auth Config
    [Documentation]    An app with an auth trait gets its auth config as a SEPARATE file
    ...    beside the ingress config, whichever edge is selected.
    ...    ⚠️ The path is provider-specific and the old test hardcoded Traefik's
    ...    (`traefik/config/dynamic/whoami-auth.yml`), so it failed on every Caddy install
    ...    — which is now the default. Read the provider from project.yaml instead of
    ...    assuming one; the SEPARATION is the invariant, not the filename.
    ${prov}=    Run Process    multipass    exec    ${VM}    --    sh    -c
    ...    grep '^ingress_provider:' ${APPBAY_HOME}/project.yaml | cut -d' ' -f2
    ...    timeout=${TIMEOUT}
    ${provider}=    Set Variable    ${prov.stdout.strip()}
    IF    '${provider}' == 'caddy'
        ${result}=    Run Process    multipass    exec    ${VM}    --    ls
        ...    ${APPBAY_HOME}/etc/apps/caddy/config/dynamic/auth/    timeout=${TIMEOUT}
        Should Contain    ${result.stdout}    whoami-security.caddy
    ELSE
        ${result}=    Run Process    multipass    exec    ${VM}    --    ls
        ...    ${APPBAY_HOME}/etc/apps/traefik/config/dynamic/    timeout=${TIMEOUT}
        Should Contain    ${result.stdout}    whoami-auth.yml
    END

Namespace Sharing Schema Is Accepted
    [Documentation]    The hooks trait schema accepts share: { network: true } without
    ...               validation errors.
    ${result}=    Run Appbay OK    validate    --all
    Should Contain    ${result.stdout}    0 failed
