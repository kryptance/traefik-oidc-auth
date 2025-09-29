#!/bin/bash

# Build the Playwright Docker image
docker build -f Dockerfile.playwright -t playwright-tests .

# Run the tests with host network mode
# This allows the container to access localhost ports on the host
docker run --rm \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/tests:/e2e/tests \
  -v $(pwd)/utils.ts:/e2e/utils.ts \
  -v $(pwd)/playwright.config.ts:/e2e/playwright.config.ts \
  -v $(pwd)/.http.yml:/e2e/.http.yml \
  -v $(pwd)/test-results:/e2e/test-results \
  -v $(pwd)/playwright-report:/e2e/playwright-report \
  -v $(realpath $(pwd)/..):/repo:ro \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -e HOST_PWD=$(pwd)/tests/keycloak \
  -e CERT_PATH=/e2e/tests/keycloak \
  -e TRAEFIK_CONFIG_PATH=/repo/workspaces/configs \
  -e PLUGIN_PATH=/repo \
  -e HTTP_CONFIG_PATH=/e2e \
  -e DATA_PATH=/e2e/tests/keycloak \
  playwright-tests \
  npm test -- "$@"