#!/bin/bash
set -e

echo "Stopping existing services..."
docker-compose down -v

echo "Starting services with test script..."
./test-keycloak.sh