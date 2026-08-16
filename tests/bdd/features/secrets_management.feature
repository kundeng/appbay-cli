# Maps to: Feature Ledger 1.12-1.13, 3.9, 3.27-3.29, S09, S15
# Covers: vault CRUD, secret injection, env_file override, scan, import

Feature: Secrets Management
  As a homelab operator
  I want to manage secrets without exposing them in compose files
  So that sensitive values are never on disk in plaintext

  Background:
    Given the appbay CLI is installed on the VM
    And the vault is initialized

  # --- Vault CRUD (3.27, 3.28) ---

  Scenario: Store and retrieve a secret
    When I run "appbay secrets set myapp/DB_PASS secretvalue"
    Then the output should confirm scope "myapp" and key "DB_PASS"
    When I run "appbay secrets get myapp/DB_PASS"
    Then the output should be "secretvalue"

  Scenario: Delete a secret
    Given secret "myapp/TEMP_KEY" exists with value "tempval"
    When I run "appbay secrets delete myapp/TEMP_KEY"
    Then "appbay secrets get myapp/TEMP_KEY" should fail with exit code 1

  Scenario: List vault entries by scope
    Given secrets exist in scopes "app-a" and "app-b"
    When I run "appbay secrets vault"
    Then the output should group entries under "app-a/" and "app-b/"

  Scenario: Overwrite warning for existing secret
    Given secret "myapp/DB_PASS" already exists
    When I run "appbay secrets set myapp/DB_PASS newvalue"
    Then the output should warn about overwriting
    And for database-pattern keys, suggest ALTER USER

  # --- Deploy-time injection (1.12, S09 D4) ---

  Scenario: Vault secrets override .env file values at deploy time
    Given app "envtest" has .env with DB_PASS=changeme
    And vault has "envtest/DB_PASS" set to "super-secret"
    When I deploy "envtest"
    Then the container env should have DB_PASS="super-secret"
    And the container env should preserve NORMAL="keep-this"

  Scenario: Auto-generation on first deploy
    Given app "autogen-test" references vault://autogen-test/NEW_KEY
    And vault://autogen-test/NEW_KEY does not exist
    When I deploy "autogen-test"
    Then a value should be auto-generated and stored in the vault
    And subsequent deploys should reuse the same value

  # --- Wrapper-file injection (S15 D4) ---

  Scenario: Wrapper-file mode hides secrets from docker inspect
    Given app "wrapper-test" uses injection mode "wrapper-file"
    When I deploy "wrapper-test"
    Then "docker inspect" should show NO secret environment variables
    And secrets should be readable as files at /run/secrets/<app>/

  # --- Scan and import (3.29, S09 P5) ---

  Scenario: Scan discovers secret-like variables
    When I run "appbay secrets scan kestra"
    Then the output should identify POSTGRES_PASSWORD as secret-like
    And report how many vars look like secrets

  Scenario: Import dry-run shows what would be stored
    When I run "appbay secrets import kestra --dry-run"
    Then the output should list secrets that would be imported
    And no secrets should actually be stored

  # --- Secret references check (3.9) ---

  Scenario: Check all secret URIs resolve
    When I run "appbay secrets check"
    Then each secret URI should report OK or a specific error
    And the summary should show total, ok, and failed counts
