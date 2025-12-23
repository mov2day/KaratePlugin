#!/bin/bash

# Setup script for Karate DSL Generator Extension

echo "Setting up Karate DSL Generator Extension..."

# Fix npm permissions if needed
if [ -d "$HOME/.npm" ]; then
    echo "Fixing npm permissions..."
    sudo chown -R $(id -u):$(id -g) "$HOME/.npm"
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Compile TypeScript
echo "Compiling TypeScript..."
npm run compile

echo "Setup complete! You can now:"
echo "1. Press F5 in VS Code to run the extension in development mode"
echo "2. Or run 'npm run package' to create a .vsix file for distribution"
