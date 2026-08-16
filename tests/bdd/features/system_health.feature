# Maps to: Feature Ledger 3.10, 3.17, 4.3
# Covers: doctor, rebuild-cache, runtime facts

Feature: System Health
  As a homelab operator
  I want to verify my Appbay installation is healthy
  So that I can diagnose issues before they affect my apps

  Background:
    Given the appbay CLI is installed on the VM

  # --- Doctor (3.10) ---

  Scenario: Doctor checks all prerequisites
    When I run "appbay doctor"
    Then it should check Docker is installed and running
    And check Docker Compose v2 is available
    And check APPBAY_HOME is set and writable
    And report "All required checks passed"

  # --- Rebuild cache (3.17) ---

  Scenario: Rebuild cache regenerates SQLite from filesystem
    When I run "appbay rebuild-cache"
    Then the cache should be regenerated successfully
    And "appbay list" should still show all apps

  # --- System info ---

  Scenario: Version reports the installed version
    When I run "appbay version"
    Then the output should contain a version string

  Scenario: Home reports APPBAY_HOME path
    When I run "appbay home"
    Then the output should be the APPBAY_HOME directory path

  Scenario: Info shows Docker and system details
    When I run "appbay info"
    Then the output should include Docker version and compose version
