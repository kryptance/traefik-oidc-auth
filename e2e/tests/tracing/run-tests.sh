#!/bin/bash

set -e

echo "Starting OpenTelemetry tracing tests..."

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install express
fi

# Start services
echo "Starting services..."
docker-compose down -v 2>/dev/null || true
docker-compose up -d

# Wait for services to be ready
echo "Waiting for services to be ready..."
max_retries=60
retry_count=0

while [ $retry_count -lt $max_retries ]; do
    if curl -s http://localhost:8080/health >/dev/null 2>&1 && \
       curl -s http://localhost:8000/realms/test >/dev/null 2>&1; then
        echo "Services are ready!"
        break
    fi
    
    retry_count=$((retry_count + 1))
    if [ $retry_count -eq $max_retries ]; then
        echo "Services failed to start after $max_retries seconds"
        docker-compose logs
        exit 1
    fi
    
    sleep 1
done

# Run the tests
echo "Running tracing tests..."
cd ../../..
npx playwright test e2e/tests/tracing/tracing.spec.ts --reporter=list

# Cleanup
echo "Cleaning up..."
cd e2e/tests/tracing
docker-compose down -v

echo "Tracing tests completed!"