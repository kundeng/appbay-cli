# Maps to: S25 requirements 2-5
# Covers: provider-neutral auth intent, Caddy Security policy, edge users, credential boundaries

Feature: Edge authentication and authorization
  As an Appbay operator
  I want one installation-selected edge to enforce application access policy
  So that application stacks do not depend on a particular ingress or identity provider

  Background:
    Given Appbay is configured with ingress provider "caddy"
    And the integrated Caddy Security edge is healthy
    And app "whoami" declares ingress and auth intent without a provider field

  Scenario: Application metadata remains provider-neutral
    When I validate app "whoami"
    Then validation should succeed
    And its appbay.yaml should not name Caddy, Traefik, Authentik, or Authelia

  Scenario: Compiler selects the installed edge adapter
    When I compile app "whoami"
    Then the physical plan should contain a Caddy route
    And the physical plan should contain a Caddy Security authorization policy
    And the logical plan should describe route and access intent without provider names

  Scenario: Unauthenticated request is challenged
    When I request the protected whoami URL without a session
    Then the edge should redirect me to its login portal
    And the application should not receive the request

  Scenario: Authorized local user reaches the application
    Given edge user "alpha-member" exists with the required role
    When I sign in as "alpha-member"
    And I request the protected whoami URL
    Then the response should be HTTP 200
    And approved identity headers should identify "alpha-member"

  Scenario: Authenticated non-member is denied
    Given edge user "alpha-outsider" exists without the required role
    When I sign in as "alpha-outsider"
    And I request the protected whoami URL
    Then the edge should return HTTP 403
    And the application should not receive the request

  Scenario: Edge user lifecycle is owned by the edge command
    When I create edge user "alpha-member" with a generated password
    Then the password should be revealed once
    And "appbay edge users list" should include "alpha-member"
    When I reset that edge user's password
    Then the old password should no longer authenticate

  Scenario: Control-plane and edge credentials are independent
    Given control-plane administrator "control-admin" exists
    And edge administrator "admin" exists
    When I reset the control-plane administrator password
    Then the edge administrator password should remain valid
    When I reset the edge administrator password
    Then the control-plane administrator session should remain valid

  Scenario: Traefik rejects an unsupported authentication capability
    Given Appbay is configured with ingress provider "traefik"
    When I compile an app that declares auth intent
    Then compilation should fail before deployment
    And the error should say that the selected edge lacks authentication capability
    And the app should not be told to select a provider
