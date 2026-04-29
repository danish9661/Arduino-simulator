#!/bin/bash
# deploy.sh
# Usage: ./deploy.sh test  OR  ./deploy.sh main

ENV=$1

if [[ "$ENV" == "test" ]]; then
    echo "Deploying to TEST Server (Port 6000)..."
    docker-compose -f docker-compose.test.yml up -d --build
elif [[ "$ENV" == "main" ]]; then
    echo "Deploying to MAIN Server (Port 5000)..."
    
    echo "Pulling latest changes for all repositories..."
    REPOS=("OpenHW-studio-frontend-danish" "openhw-studio-backend-danish" "openhw-studio-emulator-danish" "openhw-studio-examples-danish")
    
    for REPO in "${REPOS[@]}"; do
        if [ -d "$REPO/.git" ]; then
            echo "Updating $REPO..."
            cd "$REPO" || exit
            git fetch origin
            git checkout develop
            git pull origin develop
            cd ..
        else
            echo "Warning: $REPO is not a git repository or not found."
        fi
    done

    echo "Restarting Docker containers..."
    docker-compose -f docker-compose.main.yml up -d --build
else
    echo "Invalid environment. Use 'test' or 'main'."
    exit 1
fi
