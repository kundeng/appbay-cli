# Maps to: Feature Ledger 1.4-1.9, 1.10-1.11, S15
# Covers: trait system, overlays, scoped vars, magic generators, shepherd

Feature: Traits and Overlays
  As a homelab operator
  I want to declare app behaviors via traits instead of editing compose files
  So that I can add routing, auth, GPU, and secrets without touching upstream

  Background:
    Given the appbay CLI is installed on the VM

  # --- Trait validation (1.4) ---

  Scenario: Unknown trait type produces a clear error
    Given an app with trait type "nonexistent"
    When I compile the app
    Then the error should mention "Unknown trait type"
    And suggest available trait types

  Scenario: Duplicate trait type on same service is rejected
    Given an app with two "ingress" traits on the same service
    When I compile the app
    Then the error should mention "Duplicate trait type"

  # --- GPU trait (1.6) ---

  Scenario: GPU trait adds device reservation
    Given an app with a gpu trait
    And the host has an Nvidia GPU
    When I compile the app
    Then the rendered compose should include device reservations

  # --- Hooks trait (1.8) ---

  Scenario: Init hook creates a one-shot dependency
    Given an app with a hooks trait pattern "init"
    When I compile the app
    Then the rendered compose should have an init service
    And the main service should depend on it with "service_completed_successfully"

  Scenario: Sidecar hook creates a companion service
    Given an app with a hooks trait pattern "sidecar"
    When I compile the app
    Then the rendered compose should have a sidecar service
    And the sidecar should have "restart: unless-stopped"

  Scenario: Sidecar with namespace sharing
    Given an app with a sidecar and share.network=true
    When I compile the app
    Then the sidecar should have "network_mode: service:<target>"
    And the sidecar should have depends_on for the target
    And the sidecar should NOT have ports

  # --- Conditional overlays (1.9) ---

  Scenario: Overlay activates when peer app is present
    Given app "overlay-test" has an overlay with when: [authentik]
    And app "authentik" is deployed
    When I compile "overlay-test"
    Then the overlay should be applied

  Scenario: Overlay does not activate when peer is absent
    Given app "overlay-test" has an overlay with when: [nonexistent-app]
    When I compile "overlay-test"
    Then the overlay should be skipped

  # --- Scoped variables (1.10) ---

  Scenario: Project-level variables resolve correctly
    Given a project with DOMAIN="example.com"
    And an app referencing "${{project.DOMAIN}}"
    When I compile the app
    Then the rendered compose should contain "example.com"

  # --- Magic generators (1.11) ---

  Scenario: Password generator creates consistent values
    Given an app with "${password:16}" in its refs
    When I compile the app twice
    Then both renders should contain the same generated password
    And the password should be 16 characters long
