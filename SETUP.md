# Karate DSL Generator - Setup Instructions

## Quick Start

There's an npm permission issue that needs to be fixed first. Run:

```bash
sudo chown -R 501:20 "/Users/muthu/.npm"
```

Then install dependencies and compile:

```bash
cd /Users/muthu/Documents/GitHub/KaratePlugin
npm install
npm run compile
```

Or use the setup script:

```bash
./setup.sh
```

## Development

### Running the Extension

1. Open this folder in VS Code
2. Press `F5` to launch Extension Development Host
3. In the new VS Code window, try the commands:
   - `Karate: Generate Tests from OpenAPI`
   - `Karate: Generate Tests from Confluence`
   - `Karate: Generate Combined Tests`

### Testing with Sample Data

Use the provided sample OpenAPI spec:
```
examples/sample-petstore.yaml
```

### Project Structure

```
KaratePlugin/
├── src/
│   ├── extension.ts              # Main entry point
│   ├── commands/                 # Command handlers
│   │   ├── generateFromOpenAPI.ts
│   │   ├── generateFromConfluence.ts
│   │   └── generateCombined.ts
│   ├── services/                 # Core services
│   │   ├── openApiParser.ts
│   │   ├── karateGenerator.ts
│   │   ├── confluenceClient.ts
│   │   └── confluenceParser.ts
│   ├── utils/                    # Utilities
│   │   ├── logger.ts
│   │   ├── fileUtils.ts
│   │   └── configManager.ts
│   └── types/                    # TypeScript types
│       └── index.ts
├── examples/
│   └── sample-petstore.yaml      # Sample OpenAPI spec
├── package.json                  # Extension manifest
├── tsconfig.json                 # TypeScript config
└── README.md                     # User documentation
```

## Next Steps

1. **Fix npm permissions** (see above)
2. **Install dependencies**: `npm install`
3. **Compile TypeScript**: `npm run compile`
4. **Test the extension**: Press F5 in VS Code
5. **Package for distribution**: `npm run package`

## Configuration

Before using Confluence features, configure in VS Code settings:

```json
{
  "karateDsl.confluence.baseUrl": "https://yourcompany.atlassian.net/wiki",
  "karateDsl.confluence.email": "your.email@company.com"
}
```

## Features Implemented

✅ OpenAPI spec parsing (v2.0, v3.0, v3.1)
✅ Karate DSL test generation
✅ Confluence API integration
✅ Requirements and test case extraction
✅ Flowchart parsing (Mermaid)
✅ Combined test generation
✅ Secure API token storage
✅ Progress notifications
✅ File management with conflict resolution

## Known Issues

- npm permission issue on first install (see Quick Start)
- Confluence flowchart parsing supports Mermaid format primarily

## Support

For issues or questions, check the main README.md file.
