# Maps to: Feature Ledger 1.5 and S25 requirements 3-4
# Covers: installation-selected edge adapters and provider-neutral application routes

Feature: Provider-neutral ingress routing
  As an Appbay operator
  I want applications to declare routes once
  So that the installation can select Caddy or Traefik without stack-specific metadata

  Scenario Outline: The selected edge renders the same route intent
    Given the installation ingress provider is "<provider>"
    And app "whoami" declares host "whoami.local" and target port 80
    When I compile app "whoami"
    Then compilation should succeed
    And the logical plan should describe host "whoami.local" and target port 80
    And the physical plan should contain only "<artifact>" edge artifacts
    And app "whoami" should not contain provider-specific metadata

    Examples:
      | provider | artifact               |
      | caddy    | Caddy site block       |
      | traefik  | Traefik dynamic config |

  Scenario: Two applications receive non-conflicting routes
    Given apps "whoami" and "open-webui" declare distinct hosts
    When I compile both apps
    Then each should have one uniquely named route
    And neither route should overwrite the other

  Scenario: Caddy route is live after deployment
    Given the installation ingress provider is "caddy"
    And the integrated edge is healthy
    When I deploy app "whoami"
    Then Caddy configuration validation should succeed
    And a request with Host "whoami.local" should reach whoami

  Scenario: Traefik route is live after deployment
    Given the installation ingress provider is "traefik"
    And Traefik is healthy
    When I deploy app "whoami"
    Then Traefik dynamic configuration should include the route
    And a request with Host "whoami.local" should reach whoami

  Scenario: Edge ownership is exclusive
    Given Caddy currently owns ports 80 and 443
    When the installation attempts to deploy Traefik without a migration
    Then deployment should fail before changing either stack
    And the error should identify the current port owner

  Scenario: Application works after Appbay interfaces stop
    Given the edge and whoami are healthy
    When the Appbay web, desktop, and CLI processes are stopped
    Then a request routed through the edge should still return HTTP 200
