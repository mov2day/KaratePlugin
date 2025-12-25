(function () {
    const vscode = acquireVsCodeApi();

    let currentOpenApiPath = '';
    let currentCombinedOpenApiPath = '';
    let generatedContent = '';
    let history = [];
    let templates = [];
    let learnedStyle = null;

    // --- Tab Switching ---
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            switchTab(button.getAttribute('data-tab'));
        });
    });

    function switchTab(tabName) {
        // Update buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
        });

        // Update content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}-tab`);
        });

        // Refresh data based on tab
        if (tabName === 'settings') {
            vscode.postMessage({ command: 'getConfig' });
        } else if (tabName === 'template') {
            vscode.postMessage({ command: 'getTemplates' });
        } else if (tabName === 'openapi' || tabName === 'confluence' || tabName === 'combined') {
            vscode.postMessage({ command: 'getHistory' });
        }
    }

    // --- Quick Actions ---
    document.querySelectorAll('.action-button').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-action');
            switchTab(action);
        });
    });

    // --- File Selection ---
    document.getElementById('select-openapi-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'selectOpenAPIFile' });
    });

    document.getElementById('select-combined-openapi-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'selectOpenAPIFile' });
    });

    document.getElementById('openapi-file-clear').addEventListener('click', () => clearFile('openapi'));
    document.getElementById('combined-file-clear').addEventListener('click', () => clearFile('combined'));

    function clearFile(type) {
        if (type === 'openapi') {
            currentOpenApiPath = '';
            document.getElementById('openapi-file-display').style.display = 'none';
            document.getElementById('select-openapi-btn').style.display = 'block';
        } else {
            currentCombinedOpenApiPath = '';
            document.getElementById('combined-file-display').style.display = 'none';
            document.getElementById('select-combined-openapi-btn').style.display = 'block';
        }
    }

    // --- Generation Handlers ---
    document.getElementById('generate-openapi-btn').addEventListener('click', () => {
        if (!currentOpenApiPath) return showError('Please select an OpenAPI specification file');

        hideResults();
        vscode.postMessage({
            command: 'generateFromOpenAPI',
            filePath: currentOpenApiPath,
            useCopilot: document.getElementById('openapi-copilot').checked,
            templateId: document.getElementById('template-select').value
        });
    });

    document.getElementById('generate-confluence-btn').addEventListener('click', () => {
        const url = document.getElementById('confluence-url').value;
        if (!url) return showError('Please enter a Confluence page URL or ID');

        hideResults();
        vscode.postMessage({
            command: 'generateFromConfluence',
            pageUrl: url,
            useCopilot: document.getElementById('confluence-copilot').checked,
            templateId: document.getElementById('template-select').value
        });
    });

    document.getElementById('generate-combined-btn').addEventListener('click', () => {
        const confluenceUrl = document.getElementById('combined-confluence-url').value;
        if (!currentCombinedOpenApiPath) return showError('Please select an OpenAPI specification file');
        if (!confluenceUrl) return showError('Please enter a Confluence page URL or ID');

        hideResults();
        vscode.postMessage({
            command: 'generateCombined',
            openApiPath: currentCombinedOpenApiPath,
            confluenceUrl,
            useCopilot: document.getElementById('combined-copilot').checked,
            templateId: document.getElementById('template-select').value
        });
    });

    // --- Template Manager ---
    document.getElementById('save-custom-template-btn').addEventListener('click', () => {
        const name = document.getElementById('custom-template-name').value;
        if (!name) return showError('Please enter a name for your custom template');

        // This is a simplified version - in a real app you'd have an editor
        vscode.postMessage({
            command: 'saveTemplate',
            template: {
                id: name.toLowerCase().replace(/\s+/g, '-'),
                name: name,
                description: 'Custom user template',
                content: 'Feature: {{featureName}}\n\nScenario: {{scenarioName}}\n  Given url baseUrl\n  When method get' // Default placeholder
            }
        });
    });

    document.getElementById('learn-style-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'learnStyle' });
    });

    // --- Settings & Save ---
    document.getElementById('save-settings-btn').addEventListener('click', () => {
        vscode.postMessage({
            command: 'saveConfig',
            config: {
                outputPath: document.getElementById('output-path').value,
                testTemplate: document.getElementById('test-template').value,
                // These are saved via the existing ConfigManager logic in extension
                confluenceBaseUrl: document.getElementById('confluence-base-url').value,
                confluenceEmail: document.getElementById('confluence-email').value
            }
        });
    });

    // --- Result Actions ---
    document.getElementById('open-file-btn').addEventListener('click', () => {
        vscode.postMessage({
            command: 'openGeneratedFile',
            filePath: document.getElementById('result-message').dataset.filePath
        });
    });

    document.getElementById('copy-content-btn').addEventListener('click', () => {
        vscode.postMessage({
            command: 'copyToClipboard',
            content: generatedContent
        });
    });

    // --- Message Handling ---
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'fileSelected':
                handleFileSelected(message.filePath);
                break;
            case 'progress':
                showProgress(message.message, message.percentage);
                break;
            case 'success':
                showSuccess(message.message, message.filePath, message.content);
                break;
            case 'error':
                showError(message.message);
                break;
            case 'config':
                populateConfig(message.data);
                break;
            case 'configSaved':
                showTemporaryMessage('Settings saved successfully!');
                break;
            case 'history':
                renderHistory(message.data);
                break;
            case 'templates':
                renderTemplates(message.data);
                break;
            case 'styleLearned':
                handleStyleLearned(message.data);
                break;
        }
    });

    function handleFileSelected(filePath) {
        const activeTab = document.querySelector('.tab-content.active').id;
        const fileName = filePath.split(/[\\\/]/).pop();

        if (activeTab === 'openapi-tab') {
            currentOpenApiPath = filePath;
            document.getElementById('openapi-file-path').textContent = fileName;
            document.getElementById('openapi-file-display').style.display = 'flex';
            document.getElementById('select-openapi-btn').style.display = 'none';
        } else if (activeTab === 'combined-tab') {
            currentCombinedOpenApiPath = filePath;
            document.getElementById('combined-file-path').textContent = fileName;
            document.getElementById('combined-file-display').style.display = 'flex';
            document.getElementById('select-combined-openapi-btn').style.display = 'none';
        }
    }

    function renderHistory(data) {
        history = data;
        const list = document.getElementById('openapi-history-list');
        const section = document.getElementById('openapi-history');

        if (!list || !data.length) {
            if (section) section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = '';

        data.slice(0, 5).forEach(item => {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <span class="history-item-icon">${item.type === 'openapi' ? '📄' : item.type === 'confluence' ? '📋' : '🔀'}</span>
                <div class="history-item-info">
                    <div class="history-item-name">${item.source.split(/[\\\/]/).pop()}</div>
                    <div class="history-item-date">${new Date(item.timestamp).toLocaleString()}</div>
                </div>
            `;
            div.onclick = () => {
                if (item.type === 'openapi') {
                    switchTab('openapi');
                    handleFileSelected(item.source);
                } else if (item.type === 'confluence') {
                    switchTab('confluence');
                    document.getElementById('confluence-url').value = item.source;
                }
            };
            list.appendChild(div);
        });
    }

    function renderTemplates(data) {
        templates = data;
        const select = document.getElementById('template-select');
        if (!select) return;

        const currentVal = select.value;
        select.innerHTML = '';
        data.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
        if (currentVal) select.value = currentVal;
    }

    function handleStyleLearned(style) {
        learnedStyle = style;
        document.getElementById('style-info').classList.remove('hidden');
        document.getElementById('detected-indent').textContent = style.indentation.length + ' spaces';
        document.getElementById('detected-case').textContent = style.variableCase;
    }

    // --- Helper Functions ---
    function showProgress(message, percentage) {
        const container = document.getElementById('progress-container');
        container.style.display = 'block';
        document.getElementById('progress-fill').style.width = percentage + '%';
        document.getElementById('progress-text').textContent = message;
    }

    function hideProgress() {
        document.getElementById('progress-container').style.display = 'none';
    }

    function showSuccess(message, filePath, content) {
        generatedContent = content;
        hideProgress();
        const results = document.getElementById('results');
        const msg = document.getElementById('result-message');
        msg.textContent = message;
        msg.dataset.filePath = filePath;
        document.getElementById('preview-content').textContent = content.substring(0, 1500) + (content.length > 1500 ? '\n...' : '');
        results.style.display = 'block';
        document.getElementById('error').style.display = 'none';
    }

    function showError(message) {
        hideProgress();
        const error = document.getElementById('error');
        document.getElementById('error-message').textContent = message;
        error.style.display = 'block';
        document.getElementById('results').style.display = 'none';
    }

    function hideResults() {
        document.getElementById('results').style.display = 'none';
        document.getElementById('error').style.display = 'none';
    }

    function populateConfig(config) {
        document.getElementById('output-path').value = config.outputPath || '';
        document.getElementById('test-template').value = config.testTemplate || 'standard';
        document.getElementById('confluence-base-url').value = config.confluenceBaseUrl || '';
        document.getElementById('confluence-email').value = config.confluenceEmail || '';
    }

    function showTemporaryMessage(message) {
        vscode.postMessage({ command: 'copyToClipboard', content: '' }); // Just a trick to use VSCode notifications
    }

    // Initial load
    vscode.postMessage({ command: 'getConfig' });
    vscode.postMessage({ command: 'getHistory' });
})();
