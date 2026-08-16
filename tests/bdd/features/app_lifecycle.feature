# Maps to: Feature Ledger 1.1-1.3, 1.14-1.15, 1.17-1.18, 3.2-3.7
# Covers: app discovery, compile, deploy, validate, eject

Feature: App Lifecycle
  As a homelab operator
  I want to deploy, manage, and export Docker Compose apps
  So that I can run upstream apps without modifying their compose files

  Background:
    Given the appbay CLI is installed on the VM
    And the system apps (traefik, socket-proxy) are running

  # --- Discovery (1.1) ---

  Scenario: Discover apps from filesystem
    Given an app directory exists at "$APPBAY_HOME/etc/apps/whoami"
    When I run "appbay status"
    Then the output should list "whoami" with service count and trait count

  Scenario: List all discovered apps with metadata
    When I run "appbay list"
    Then the output should show columns PROJECT, ENVIRONMENT, COMPOSE FILE
    And the app count should be at least 10

  # --- Compile (1.2, 1.3) ---

  Scenario: Compile produces rendered output
    When I run "appbay compile whoami"
    Then a rendered compose file exists at "var/lib/renders/whoami/docker-compose.rendered.yml"
    And the rendered compose has namespace-prefixed container names

  Scenario: Compile is deterministic
    When I run "appbay compile whoami" twice
    Then the rendered output is identical both times

  # --- Validate (1.17) ---

  Scenario: Validate checks all apps
    When I run "appbay validate --all"
    Then every app should pass with 0 failures

  Scenario: Validate catches invalid appbay.yaml
    Given an app with an invalid trait type "nonexistent"
    When I run "appbay validate badapp"
    Then the output should contain an error about unknown trait type

  # --- Deploy (1.15, 3.2) ---

  Scenario: Deploy a bare compose app
    Given an app with only a docker-compose.yml (no appbay.yaml)
    When I run "appbay up <app>"
    Then the container should be running
    And "appbay status" should list it

  Scenario: Redeploy an existing app
    Given app "it-tools" is deployed and running
    When I force recompile and run "appbay up it-tools"
    Then the deploy should succeed
    And the container should be running

  Scenario: Deploy with collection filter
    When I run "appbay up --collection system"
    Then only apps in the "system" collection should be deployed

  # --- Eject (1.18) ---

  Scenario: Eject produces standalone compose
    When I run "appbay eject whoami"
    Then the ejected directory should contain docker-compose.yml
    And the ejected compose should have all services from the original
    And a README with run instructions should exist

  Scenario: Ejected compose is runnable without appbay
    When I eject app "whoami" to a clean directory
    Then "docker compose up -d" should succeed in that directory

  # --- Plan/Diff (1.14) ---

  Scenario: Plan shows changes before deploy
    Given app "whoami" has a config change
    When I run "appbay compile whoami"
    Then the plan should show status CHANGED
    And secret values should be redacted in the diff

  # --- Down/Restart (3.2) ---

  Scenario: Down stops containers
    Given app "it-tools" is running
    When I run "appbay down it-tools"
    Then the container should not be running

  Scenario: Restart recreates containers
    Given app "it-tools" is running
    When I run "appbay restart it-tools"
    Then the container should be running with a new creation time
