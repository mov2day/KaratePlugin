(function () {
    const vscode = acquireVsCodeApi();

    let currentFilePath = '';
    let currentCombinedFilePath = '';
    let generatedContent = '';

    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');

            // Update buttons
            document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Update content
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            document.getElementById(`${tabName}-tab`).classList.add('active');

            // Request config when settings tab is opened
            if (tabName === 'settings') {
                vscode.postMessage({ command: 'getConfig' });
            }
        });
    });

    // OpenAPI file selection
    document.getElementById('select-openapi-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'selectOpenAPIFile' });
    });

    document.getElementById('select-combined-openapi-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'selectOpenAPIFile' });
    });

    // Generate from OpenAPI
    document.getElementById('generate-openapi-btn').addEventListener('click', () => {
        const filePath = document.getElementById('openapi-file').value;
        const useCopilot = document.getElementById('openapi-copilot').checked;

        if (!filePath) {
            showError('Please select an OpenAPI specification file');
            return;
        }

        hideResults();
        vscode.postMessage({
            command: 'generateFromOpenAPI',
            filePath,
            useCopilot
        });
    });

    // Generate from Confluence
    document.getElementById('generate-confluence-btn').addEventListener('click', () => {
        const pageUrl = document.getElementById('confluence-url').value;
        const useCopilot = document.getElementById('confluence-copilot').checked;

        if (!pageUrl) {
            showError('Please enter a Confluence page URL or ID');
            return;
        }

        hideResults();
        vscode.postMessage({
            command: 'generateFromConfluence',
            pageUrl,
            useCopilot
        });
    });

    // Generate combined
    document.getElementById('generate-combined-btn').addEventListener('click', () => {
        const openApiPath = document.getElementById('combined-openapi-file').value;
        const confluenceUrl = document.getElementById('combined-confluence-url').value;
        const useCopilot = document.getElementById('combined-copilot').checked;

        if (!openApiPath) {
            showError('Please select an OpenAPI specification file');
            return;
        }

        if (!confluenceUrl) {
            showError('Please enter a Confluence page URL or ID');
            return;
        }

        hideResults();
        vscode.postMessage({
            command: 'generateCombined',
            openApiPath,
            confluenceUrl,
            useCopilot
        });
    });

    // Save settings
    document.getElementById('save-settings-btn').addEventListener('click', () => {
        const config = {
            outputPath: document.getElementById('output-path').value,
            testTemplate: document.getElementById('test-template').value,
            useCopilot: document.getElementById('openapi-copilot').checked
        };

        vscode.postMessage({
            command: 'saveConfig',
            config
        });
    });

    // Open generated file
    document.getElementById('open-file-btn').addEventListener('click', () => {
        vscode.postMessage({
            command: 'openFile',
            filePath: document.getElementById('result-message').dataset.filePath
        });
    });

    // Copy to clipboard
    document.getElementById('copy-content-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(generatedContent).then(() => {
            const btn = document.getElementById('copy-content-btn');
            const originalText = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        });
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'fileSelected':
                currentFilePath = message.filePath;
                const activeTab = document.querySelector('.tab-content.active');

                if (activeTab.id === 'openapi-tab') {
                    document.getElementById('openapi-file').value = message.filePath;
                } else if (activeTab.id === 'combined-tab') {
                    currentCombinedFilePath = message.filePath;
                    document.getElementById('combined-openapi-file').value = message.filePath;
                }
                break;

            case 'progress':
                showProgress(message.message, message.percentage);
                break;

            case 'success':
                hideProgress();
                showSuccess(message.message, message.filePath, message.content);
                break;

            case 'error':
                hideProgress();
                showError(message.message);
                break;

            case 'config':
                populateConfig(message.data);
                break;

            case 'configSaved':
                showTemporaryMessage('Settings saved successfully!');
                break;
        }
    });

    function showProgress(message, percentage) {
        const container = document.getElementById('progress-container');
        const fill = document.getElementById('progress-fill');
        const text = document.getElementById('progress-text');

        container.style.display = 'block';
        fill.style.width = percentage + '%';
        text.textContent = message;
    }

    function hideProgress() {
        document.getElementById('progress-container').style.display = 'none';
    }

    function showSuccess(message, filePath, content) {
        generatedContent = content;

        const results = document.getElementById('results');
        const resultMessage = document.getElementById('result-message');
        const previewContent = document.getElementById('preview-content');

        resultMessage.textContent = message;
        resultMessage.dataset.filePath = filePath;
        previewContent.textContent = content.substring(0, 1000) + (content.length > 1000 ? '\n...' : '');

        results.style.display = 'block';
        document.getElementById('error').style.display = 'none';
    }

    function showError(message) {
        const error = document.getElementById('error');
        const errorMessage = document.getElementById('error-message');

        errorMessage.textContent = message;
        error.style.display = 'block';
        document.getElementById('results').style.display = 'none';
    }

    function hideResults() {
        document.getElementById('results').style.display = 'none';
        document.getElementById('error').style.display = 'none';
        document.getElementById('progress-container').style.display = 'none';
    }

    function populateConfig(config) {
        if (config.outputPath) {
            document.getElementById('output-path').value = config.outputPath;
        }
        if (config.testTemplate) {
            document.getElementById('test-template').value = config.testTemplate;
        }
        if (config.confluenceBaseUrl) {
            document.getElementById('confluence-base-url').value = config.confluenceBaseUrl;
        }
        if (config.confluenceEmail) {
            document.getElementById('confluence-email').value = config.confluenceEmail;
        }
    }

    function showTemporaryMessage(message) {
        const temp = document.createElement('div');
        temp.className = 'results';
        temp.innerHTML = `<h3>✓ ${message}</h3>`;
        temp.style.position = 'fixed';
        temp.style.top = '20px';
        temp.style.right = '20px';
        temp.style.zIndex = '1000';
        document.body.appendChild(temp);

        setTimeout(() => {
            temp.remove();
        }, 3000);
    }

    // Request initial config
    vscode.postMessage({ command: 'getConfig' });
})();
