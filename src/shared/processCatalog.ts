export interface ProcessDescriptor {
    id: string;
    label: string;
}

const directProcessLabels: Record<string, string> = {
    generateFromOpenAPI: 'Generating tests from OpenAPI…',
    generateFromConfluence: 'Generating tests from Confluence…',
    generateCombined: 'Generating combined test coverage…',
    syncTests: 'Synchronising generated tests…',
    huntApiBugs: 'Running API Bug Hunter…',
    learnStyle: 'Learning your Karate style…',
    runProfile: 'Running saved profile…',
    rerunRun: 'Rerunning tests…',
    exportRunReport: 'Preparing run report…',
    requestScenarioRepair: 'Preparing repair review…',
    analyzeCoverage: 'Analysing API coverage…',
    exportCoverageReport: 'Preparing coverage report…',
    generateCoverageTest: 'Generating coverage test…'
};

const extensionCommandLabels: Record<string, string> = {
    'karate-dsl.runFeature': 'Running feature…',
    'karate-dsl.runScenario': 'Running scenario…',
    'karate-dsl.runFolder': 'Running test suite…',
    'karate-dsl.runByTags': 'Running tagged tests…',
    'karate-dsl.analyzeProjectHealth': 'Analysing project health…',
    'karate-dsl.checkSpecChanges': 'Checking specification changes…',
    'karate-dsl.generateFromOpenAPI': 'Generating tests from OpenAPI…',
    'karate-dsl.importPostmanCollection': 'Importing Postman collection…',
    'karate-dsl.importHar': 'Importing HAR recording…',
    'karate-dsl.generateFromGraphQL': 'Generating tests from GraphQL…',
    'karate-dsl.generateFromJira': 'Generating tests from Jira…',
    'karate-dsl.generateFromConfluence': 'Generating tests from Confluence…',
    'karate-dsl.generateCombined': 'Generating combined test coverage…',
    'karate-dsl.generateFromDirectory': 'Generating tests from API definitions…',
    'karate-dsl.startRecording': 'Starting test recording…',
    'karate-dsl.huntApiBugs': 'Running API Bug Hunter…'
};

export function getProcessDescriptor(message: { command: string; commandId?: unknown }): ProcessDescriptor | undefined {
    if (message.command === 'executeExtensionCommand' && typeof message.commandId === 'string') {
        const label = extensionCommandLabels[message.commandId];
        return label ? { id: `command:${message.commandId}`, label } : undefined;
    }
    const label = directProcessLabels[message.command];
    return label ? { id: message.command, label } : undefined;
}
