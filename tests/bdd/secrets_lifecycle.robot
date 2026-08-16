*** Settings ***
Documentation     Secrets lifecycle integration tests against a live multipass VM.
...               Validates the full secret management journey: vault init, set/get/delete,
...               app deployment with vault injection, env_file override, scan, and import.
Library           Process
Resource          fixtures.resource
Library           String

Suite Setup       Verify VM And Vault Ready

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
Verify VM And Vault Ready
    [Documentation]    The vault must exist and hold at least one secret for this suite.
    ...    ⚠️ THIS USED TO REQUIRE A PRE-SEEDED VAULT and nothing else — so on any install
    ...    whose vault was empty, SUITE SETUP failed and took all six tests with it,
    ...    reporting six failures for one missing precondition. An empty vault is the normal
    ...    state of a fresh install; the suite provisions what it needs.
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    appbay    secrets    vault
    ...    timeout=${TIMEOUT}
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Vault is not initialized. Run `appbay secrets init` on ${VM}.
    ${empty}=    Run Keyword And Return Status    Should Contain    ${result.stdout}    Vault is empty
    IF    ${empty}
        Run Process    multipass    exec    ${VM}    --    ${PRIV}    bash    -c
        ...    printf '%s' 'bdd-suite-marker' | appbay secrets set BDD_SUITE_MARKER
        ...    timeout=${TIMEOUT}
        ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    appbay    secrets    vault
        ...    timeout=${TIMEOUT}
    END
    Should Contain    ${result.stdout}    secret(s)

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

Run Docker On VM
    [Arguments]    @{args}
    ${result}=    Run Process    multipass    exec    ${VM}    --    ${PRIV}    ${CONTAINER_BIN}    @{args}
    ...    timeout=${TIMEOUT}
    RETURN    ${result}

Set Up Envtest Fixture
    [Documentation]    An app whose .env supplies placeholder values that vault secrets
    ...    must override, plus one non-secret that must survive untouched.
    Set Vault Secret    envtest/DB_PASS    super-secret-db-pw
    Set Vault Secret    envtest/API_KEY    sk-12345-api-key
    ${refs}=    Catenate    SEPARATOR=\n
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}DB_PASS: vault://envtest/DB_PASS
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}API_KEY: vault://envtest/API_KEY
    ${envfile}=    Catenate    SEPARATOR=\n
    ...    DB_PASS=overridden-by-vault
    ...    API_KEY=overridden-by-vault
    ...    NORMAL=keep-this
    Provision Deployed Secret App    envtest    runtime-env    ${refs}    ${envfile}    DB_PASS, API_KEY

Set Up Wrapper Fixture
    [Documentation]    An app using wrapper-file injection: secrets land as FILES and must
    ...    not appear in the container environment at all.
    Set Vault Secret    wrapper-test/DB_PASSWORD    super-secret-wrapper-pw
    ${refs}=    Set Variable
    ...    ${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}${SPACE}DB_PASSWORD: vault://wrapper-test/DB_PASSWORD
    Provision Deployed Secret App    wrapper-test    wrapper-file    ${refs}


*** Test Cases ***
Vault CRUD Lifecycle
    [Documentation]    Full vault CRUD: set scoped secret, get, overwrite with warning, delete, verify gone.
    # Set a scoped secret
    ${set}=    Run Appbay OK    secrets    set    bdd-test/SECRET_A    value-alpha
    Should Contain    ${set.stdout}    scope: bdd-test
    Should Contain    ${set.stdout}    vault://bdd-test/SECRET_A

    # Get it back
    ${get}=    Run Appbay OK    secrets    get    bdd-test/SECRET_A
    Should Contain    ${get.stdout}    value-alpha

    # Overwrite — should warn
    ${overwrite}=    Run Appbay OK    secrets    set    bdd-test/SECRET_A    value-beta
    Should Contain    ${overwrite.stdout}    already existed and was overwritten

    # Verify new value
    ${get2}=    Run Appbay OK    secrets    get    bdd-test/SECRET_A
    Should Contain    ${get2.stdout}    value-beta

    # Delete
    ${del}=    Run Appbay OK    secrets    delete    bdd-test/SECRET_A
    Should Contain    ${del.stdout}    deleted

    # Verify gone
    ${gone}=    Run Appbay    secrets    get    bdd-test/SECRET_A
    Should Not Be Equal As Integers    ${gone.rc}    0

Vault Lists Show Scoped Entries
    [Documentation]    Set secrets in multiple scopes, verify vault list groups them correctly.
    Run Appbay OK    secrets    set    scope-a/KEY1    val1
    Run Appbay OK    secrets    set    scope-a/KEY2    val2
    Run Appbay OK    secrets    set    scope-b/KEY1    val3

    ${vault}=    Run Appbay OK    secrets    vault
    Should Contain    ${vault.stdout}    scope-a/
    Should Contain    ${vault.stdout}    scope-b/
    Should Contain    ${vault.stdout}    KEY1
    Should Contain    ${vault.stdout}    KEY2

    # Cleanup
    Run Appbay OK    secrets    delete    scope-a/KEY1
    Run Appbay OK    secrets    delete    scope-a/KEY2
    Run Appbay OK    secrets    delete    scope-b/KEY1

Deploy With Vault Secrets Overrides Env File
    [Documentation]    Deploy an app that uses env_file. Vault secrets injected via
    ...               process env should override the .env file values. Non-secret
    ...               vars should be preserved.
    ...    ⚠️ Provisions and DEPLOYS its own app. It previously assumed `appbay.envtest.app`
    ...    was already running on the host — true only on the retired appbay-test VM.
    [Setup]    Set Up Envtest Fixture
    [Teardown]    Remove Deployed Fixture    envtest
    ${result}=    Run Docker On VM    exec    appbay.envtest.app    env
    Should Be Equal As Integers    ${result.rc}    0

    # Vault-injected values should override .env
    Should Contain    ${result.stdout}    DB_PASS=super-secret-db-pw
    Should Contain    ${result.stdout}    API_KEY=sk-12345-api-key

    # Non-secret vars from .env preserved
    Should Contain    ${result.stdout}    NORMAL=keep-this

Wrapper File Injection Hides Secrets From Docker Inspect
    [Documentation]    Wrapper-file injection mode writes secrets as files to a shared
    ...               volume. docker inspect should show NO secret env vars.
    ...    🚨 This is the test that proves the injection mode does what it claims. If it is
    ...    skipped for want of a fixture — as it has been since it was written — nothing
    ...    else in the project checks that wrapper-file keeps secrets out of the container
    ...    environment.
    [Setup]    Set Up Wrapper Fixture
    [Teardown]    Remove Deployed Fixture    wrapper-test
    # Check container env via docker inspect
    ${inspect}=    Run Docker On VM    inspect    appbay.wrapper-test.app
    ...    --format    {{json .Config.Env}}
    Should Be Equal As Integers    ${inspect.rc}    0
    Should Not Contain    ${inspect.stdout}    super-secret
    Should Not Contain    ${inspect.stdout}    sk-wrapper
    Should Contain    ${inspect.stdout}    PATH=

    # But secrets are readable as files inside the container
    ${cat}=    Run Docker On VM    exec    appbay.wrapper-test.app
    ...    cat    /run/secrets/wrapper-test/DB_PASSWORD
    Should Be Equal As Integers    ${cat.rc}    0
    Should Contain    ${cat.stdout}    super-secret-wrapper-pw

Scan Discovers Secret Like Variables
    [Documentation]    appbay secrets scan finds secret-like env vars in an app's
    ...               compose and .env files.
    ...    ⚠️ Provisions its own app. This used to scan `kestra`, which is not in the
    ...    catalogue — it existed only on a hand-seeded VM, so the test could not run
    ...    anywhere else.
    [Setup]    Provision Secret Scan Fixture
    [Teardown]    Remove App Fixture    scantest
    ${scan}=    Run Appbay OK    secrets    scan    scantest
    Should Contain    ${scan.stdout}    POSTGRES_PASSWORD
    Should Contain    ${scan.stdout}    API_TOKEN
    # Match what the scanner actually prints. The old wording ("look like secrets") was
    # carried over from a previous output format and asserted text nothing emits.
    Should Contain    ${scan.stdout}    Detected secrets
    # LOG_LEVEL must be classified as an ordinary variable, not a secret — a scanner that
    # flags everything is noise, not signal.
    # ⚠️ Assert on the SECRETS SECTION, not the whole report: LOG_LEVEL legitimately
    # appears further down under "Other env vars". A blanket `Should Not Contain` failed
    # here and was testing the wrong thing.
    ${secrets_section}=    Fetch From Left    ${scan.stdout}    Other env vars
    Should Not Contain    ${secrets_section}    LOG_LEVEL
    Should Contain    ${scan.stdout}    Other env vars
    Should Contain    ${scan.stdout}    2 look like secrets

Import Dry Run Shows What Would Be Imported
    [Documentation]    appbay secrets import --dry-run shows secrets that would be
    ...               imported without actually storing them.
    [Setup]    Provision Secret Scan Fixture
    [Teardown]    Remove App Fixture    scantest
    ${import}=    Run Appbay OK    secrets    import    scantest    --dry-run
    Should Contain    ${import.stdout}    import
    Should Contain    ${import.stdout}    Would import
    # 🚨 A DRY RUN MUST NOT WRITE. Nothing else in the suite would notice if it did.
    ${vault}=    Run Appbay OK    secrets    vault
    Should Not Contain    ${vault.stdout}    POSTGRES_PASSWORD
