#!/bin/bash
# deploy.sh
# Usage: ./deploy.sh test  OR  ./deploy.sh main

ENV=$1

if [[ "$ENV" == "test" ]]; then
    echo "Deploying to TEST Server (Port 6000)..."
    docker-compose -f docker-compose.test.yml up -d --build
elif [[ "$ENV" == "main" ]]; then
    echo "Deploying to MAIN Server (Port 5000)..."
    docker-compose -f docker-compose.main.yml up -d --build
else
    echo "Invalid environment. Use 'test' or 'main'."
    exit 1
fi
